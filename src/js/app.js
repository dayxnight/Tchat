import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js";
import { ref, get } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-database.js";

import { 
    initTheme, 
    toggleTheme, 
    changeAccent 
} from "./theme.js";

import { 
    handleRegister, 
    handleLogin, 
    handleLogout, 
    saveProfile 
} from "./auth.js";

import { 
    loadFriendList, 
    addFriend, 
    selectFriend, 
    handleBack, 
    stopChatListener, 
    stopFriendPreviews, 
    sendMessage, 
    clearChat, 
    deleteMessage, 
    replyMessage, 
    addReaction 
} from "./chat.js";

// --- Global State ---
const state = {
    currentPage: 'loading',
    // Halaman aktif antara dua halaman terpisah: 'sidebar' | 'chat'
    view: 'sidebar',

    // Current User Data
    myUid: '',
    myUsername: '',
    myFullName: '',
    tempFullName: '',

    // Auth Flags
    authLoading: false,
    authMode: 'login',
    profileEditMode: false,

    // Friend list
    friends: [],
    loadingFriends: false,
    activeFriendUid: null,
    activeFriendName: '',

    // Messages
    messages: [],
    loadingMessages: false,
    replyingTo: null,
    searchActive: false,
    searchQuery: '',

    // Theme Config
    darkTheme: false,
    accentColor: 'blue',

    // Dropdown / Menus UI States
    menuOpen: false,
    accentMenuOpen: false,
    chatMenuOpen: false,
    msgMenuOpen: false,
    selectedMsg: null,
    msgMenuX: 0,
    msgMenuY: 0,

    modal: {
        show: false,
        title: '',
        message: '',
        type: 'alert',
        onConfirm: null
    }
};

// --- Global Helpers ---
export function getInitials(name) {
    if (!name) return "?";
    return name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
}

export function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';

    const time = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    const isToday = d.toDateString() === new Date().toDateString();
    if (isToday) return time;

    // Pesan lama ikut menampilkan tanggalnya
    const date = d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
    return `${date}, ${time}`;
}

// Format waktu ringkas untuk daftar teman (WhatsApp-style):
// hari ini => jam, kemarin => "Kemarin", lebih lama => tanggal
function formatListTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMsg = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const dayDiff = Math.round((startOfToday - startOfMsg) / 86400000);

    if (dayDiff === 0) return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    if (dayDiff === 1) return 'Kemarin';
    return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
}

// Teks preview pesan di daftar teman
function getFriendPreview(msg, myUid) {
    if (!msg || !msg.teks) return 'Belum ada pesan';
    return msg.pengirimUid === myUid ? `Anda: ${msg.teks}` : msg.teks;
}

function getFilteredMessages() {
    if (!state.searchQuery || !state.searchQuery.trim()) {
        return state.messages;
    }
    const q = state.searchQuery.toLowerCase();
    return state.messages.filter(m => m.teks && m.teks.toLowerCase().includes(q));
}

// Membaca profil user dengan retry — menghindari race condition saat registrasi
// (data user mungkin belum tertulis saat listener auth pertama kali terpicu).
async function fetchUserProfile(uid) {
    let attempts = 0;
    while (attempts < 5) {
        try {
            const snapshot = await get(ref(db, 'users/' + uid));
            if (snapshot.exists()) return snapshot.val();
        } catch (err) {
            console.warn("Gagal membaca profil (percobaan ke-" + (attempts + 1) + "):", err);
        }
        attempts++;
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    return null;
}

// --- UI Rendering Callbacks (MVP View implementation) ---
let toastTimer = null;

const uiCallbacks = {
    showModal(title, message, type = 'alert', onConfirm = null) {
        state.modal.title = title;
        state.modal.message = message;
        state.modal.type = type;
        state.modal.onConfirm = onConfirm;
        state.modal.show = true;
        
        document.getElementById('dialog-title').textContent = title;
        document.getElementById('dialog-message').textContent = message;
        
        const cancelBtn = document.getElementById('btn-dialog-cancel');
        if (type === 'confirm') {
            cancelBtn.classList.remove('d-none');
        } else {
            cancelBtn.classList.add('d-none');
        }
        
        document.getElementById('dialog-modal').classList.remove('d-none');
    },

    closeModal() {
        state.modal.show = false;
        document.getElementById('dialog-modal').classList.add('d-none');
    },

    showToast(message) {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.classList.remove('d-none');
        void toast.offsetWidth; // paksa reflow agar transisi berjalan
        toast.classList.add('show');

        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            toast.classList.remove('show');
            // Jangan sembunyikan bila toast baru sudah muncul dalam 300ms ini
            setTimeout(() => {
                if (!toast.classList.contains('show')) {
                    toast.classList.add('d-none');
                }
            }, 300);
        }, 2200);
    },

    setCurrentPage(page) {
        state.currentPage = page;
        document.querySelectorAll('.app-screen').forEach(el => el.classList.add('d-none'));
        const screenEl = document.getElementById(`screen-${page}`);
        if (screenEl) screenEl.classList.remove('d-none');
    },

    setAuthMode(mode) {
        state.authMode = mode;
        if (mode === 'login') {
            document.getElementById('auth-login-container').classList.remove('d-none');
            document.getElementById('auth-register-container').classList.add('d-none');
        } else {
            document.getElementById('auth-login-container').classList.add('d-none');
            document.getElementById('auth-register-container').classList.remove('d-none');
        }
    },

    updateAuthLoading(loading) {
        const loginBtn = document.getElementById('btn-login');
        const regBtn = document.getElementById('btn-register');
        
        if (loading) {
            loginBtn.disabled = true;
            regBtn.disabled = true;
            loginBtn.querySelector('.btn-text').classList.add('d-none');
            loginBtn.querySelector('.spinner').classList.remove('d-none');
            regBtn.querySelector('.btn-text').classList.add('d-none');
            regBtn.querySelector('.spinner').classList.remove('d-none');
        } else {
            loginBtn.disabled = false;
            regBtn.disabled = false;
            loginBtn.querySelector('.btn-text').classList.remove('d-none');
            loginBtn.querySelector('.spinner').classList.add('d-none');
            regBtn.querySelector('.btn-text').classList.remove('d-none');
            regBtn.querySelector('.spinner').classList.add('d-none');
        }
    },

    clearRegisterInputs() {
        document.getElementById('reg-fullname').value = '';
        document.getElementById('reg-username').value = '';
        document.getElementById('reg-password').value = '';
    },

    clearLoginInputs() {
        document.getElementById('login-username').value = '';
        document.getElementById('login-password').value = '';
    },

    clearAddFriendInput() {
        document.getElementById('search-friend-input').value = '';
    },

    clearChatInput() {
        document.getElementById('chat-input-text').value = '';
    },

    resetSearch() {
        state.searchActive = false;
        state.searchQuery = '';
        document.getElementById('chat-search-bar-header').classList.add('d-none');
        document.getElementById('active-friend-search-status').classList.add('d-none');
        document.getElementById('search-menu-icon').textContent = 'search';
        document.getElementById('search-menu-text').textContent = 'Cari Pesan';
        document.getElementById('chat-search-query-input').value = '';
        uiCallbacks.renderMessages();
    },

    updateFriendsLoading(loading) {
        const spinner = document.getElementById('friends-loading-spinner');
        if (loading) {
            spinner.classList.remove('d-none');
        } else {
            spinner.classList.add('d-none');
        }
    },

    updateMyProfileUI() {
        document.getElementById('my-fullname').textContent = state.myFullName;
        document.getElementById('my-username').textContent = `@${state.myUsername}`;
        document.getElementById('my-avatar').textContent = getInitials(state.myFullName);
    },

    renderFriendList() {
        const container = document.getElementById('friends-list-items');
        container.innerHTML = '';
        
        const emptyState = document.getElementById('friends-empty-state');
        if (!state.loadingFriends && state.friends.length === 0) {
            emptyState.classList.remove('d-none');
            return;
        } else {
            emptyState.classList.add('d-none');
        }

        state.friends.forEach(friend => {
            const item = document.createElement('div');
            item.className = 'friend-item';
            item.dataset.uid = friend.uid;
            if (state.activeFriendUid === friend.uid) {
                item.classList.add('active');
            }

            const avatar = document.createElement('div');
            avatar.className = 'avatar';
            avatar.style.backgroundColor = 'var(--pc)'; // Avatar mengikuti warna aksen tema
            avatar.textContent = getInitials(friend.nama_lengkap);

            const info = document.createElement('div');
            info.className = 'friend-info';

            const top = document.createElement('div');
            top.className = 'friend-top';

            const name = document.createElement('span');
            name.className = 'friend-name';
            name.textContent = friend.nama_lengkap;

            const time = document.createElement('span');
            time.className = 'friend-time';
            time.textContent = formatListTime(friend.lastMsg ? friend.lastMsg.waktu : null);

            top.appendChild(name);
            top.appendChild(time);

            const bottom = document.createElement('div');
            bottom.className = 'friend-bottom';

            const preview = document.createElement('span');
            preview.className = 'friend-preview';
            preview.textContent = getFriendPreview(friend.lastMsg, state.myUid);

            bottom.appendChild(preview);

            info.appendChild(top);
            info.appendChild(bottom);

            item.appendChild(avatar);
            item.appendChild(info);

            item.addEventListener('click', () => {
                selectFriend(state, friend, uiCallbacks);
            });

            container.appendChild(item);
        });
    },

    updateFriendPreview(uid, lastMsg) {
        const item = document.querySelector(`.friend-item[data-uid="${uid}"]`);
        if (!item) return;
        const timeEl = item.querySelector('.friend-time');
        const previewEl = item.querySelector('.friend-preview');
        if (timeEl) timeEl.textContent = formatListTime(lastMsg ? lastMsg.waktu : null);
        if (previewEl) previewEl.textContent = getFriendPreview(lastMsg, state.myUid);
    },

    async reloadFriendList() {
        await loadFriendList(state, uiCallbacks);
    },

    renderActiveFriendHeader() {
        const placeholder = document.getElementById('no-active-friend-placeholder');
        const details = document.getElementById('active-friend-header-details');
        const actions = document.getElementById('chat-header-actions');
        const inputArea = document.getElementById('chat-input-area');

        if (state.activeFriendUid) {
            placeholder.classList.add('d-none');
            details.classList.remove('d-none');
            actions.classList.remove('d-none');
            inputArea.classList.remove('d-none');

            document.getElementById('active-friend-name').textContent = state.activeFriendName;
            
            const avatar = document.getElementById('active-friend-avatar');
            avatar.style.backgroundColor = 'var(--pc)'; // Mengikuti warna aksen tema
            avatar.textContent = getInitials(state.activeFriendName);
        } else {
            placeholder.classList.remove('d-none');
            details.classList.add('d-none');
            actions.classList.add('d-none');
            inputArea.classList.add('d-none');
        }
    },

    updateChatLayoutView() {
        const sidebar = document.getElementById('chat-sidebar');
        const chatArea = document.getElementById('chat-area');
        
        if (state.view === 'chat') {
            sidebar.classList.remove('show');
            chatArea.classList.add('show');
        } else {
            sidebar.classList.add('show');
            chatArea.classList.remove('show');
        }
    },

    renderMessages() {
        const container = document.getElementById('messages-list-items');
        const messagesBox = document.getElementById('chat-messages-container');

        // Simpan posisi scroll agar tidak terlempar saat daftar di-render ulang
        const wasNearBottom = !messagesBox ||
            messagesBox.scrollHeight - messagesBox.scrollTop - messagesBox.clientHeight < 150;
        const prevScrollTop = messagesBox ? messagesBox.scrollTop : 0;

        container.innerHTML = '';

        const emptyState = document.getElementById('chat-empty-state');
        const searchEmpty = document.getElementById('chat-search-empty-state');
        const spinner = document.getElementById('messages-loading-spinner');

        searchEmpty.classList.add('d-none');

        if (!state.activeFriendUid) {
            emptyState.classList.remove('d-none');
            spinner.classList.add('d-none');
            return wasNearBottom;
        } else {
            emptyState.classList.add('d-none');
        }

        if (state.loadingMessages) {
            spinner.classList.remove('d-none');
            return wasNearBottom;
        } else {
            spinner.classList.add('d-none');
        }

        const filteredMessages = getFilteredMessages();

        // State kosong khusus saat pencarian aktif tanpa hasil
        if (filteredMessages.length === 0 && state.searchQuery.trim()) {
            searchEmpty.classList.remove('d-none');
            return wasNearBottom;
        }

        filteredMessages.forEach(msg => {
            const wrapper = document.createElement('div');
            wrapper.className = 'message-wrapper';

            const message = document.createElement('div');
            message.className = 'message';
            message.dataset.id = msg.id;
            
            if (msg.pengirimUid === state.myUid) {
                message.classList.add('sent');
            } else {
                message.classList.add('received');
            }

            // Highlight matches
            if (state.searchQuery && msg.teks && msg.teks.toLowerCase().includes(state.searchQuery.toLowerCase())) {
                message.classList.add('highlight');
            }

            // Reply Preview inside message
            if (msg.balasKe) {
                const replyPreview = document.createElement('div');
                replyPreview.className = 'reply-preview-in-msg';

                const replySender = document.createElement('span');
                replySender.style.fontSize = '0.7rem';
                replySender.style.fontWeight = '800';
                replySender.style.opacity = '0.7';
                replySender.textContent = msg.balasKe.pengirim;

                const replyText = document.createElement('p');
                replyText.style.fontSize = '0.8rem';
                replyText.style.margin = '0';
                replyText.textContent = msg.balasKe.teks;

                replyPreview.appendChild(replySender);
                replyPreview.appendChild(replyText);
                message.appendChild(replyPreview);
            }

            // Text content
            const textSpan = document.createElement('span');
            textSpan.textContent = msg.teks || '';
            message.appendChild(textSpan);

            // Footer (reaction & time)
            const footer = document.createElement('div');
            footer.style.display = 'flex';
            footer.style.justifyContent = 'space-between';
            footer.style.alignItems = 'center';
            footer.style.marginTop = '4px';

            if (msg.reaksi) {
                const reactionTag = document.createElement('div');
                reactionTag.className = 'reaction-tag';
                reactionTag.textContent = msg.reaksi;
                footer.appendChild(reactionTag);
            }

            const timeSpan = document.createElement('span');
            timeSpan.className = 'msg-time';
            timeSpan.textContent = formatTime(msg.waktu);
            footer.appendChild(timeSpan);

            message.appendChild(footer);
            wrapper.appendChild(message);
            container.appendChild(wrapper);
        });

        // Pulihkan posisi scroll bila user sedang membaca pesan lama
        if (!wasNearBottom && messagesBox) {
            const prevBehavior = messagesBox.style.scrollBehavior;
            messagesBox.style.scrollBehavior = 'auto';
            messagesBox.scrollTop = prevScrollTop;
            messagesBox.style.scrollBehavior = prevBehavior;
        }

        return wasNearBottom;
    },

    updateReplyPreview() {
        const replyBar = document.getElementById('reply-preview-bar');
        const replySender = document.getElementById('reply-preview-sender');
        const replyText = document.getElementById('reply-preview-text');

        if (state.replyingTo) {
            replySender.textContent = `Membalas ${state.replyingTo.pengirim}`;
            replyText.textContent = state.replyingTo.teks;
        }
        replyBar.classList.toggle('d-none', !state.replyingTo);
    },

    closeAllMenus() {
        state.menuOpen = false;
        state.accentMenuOpen = false;
        state.chatMenuOpen = false;
        state.msgMenuOpen = false;

        document.getElementById('sidebar-menu').classList.remove('active');
        document.getElementById('accent-dropdown-list').classList.remove('active');
        document.getElementById('chat-header-menu').classList.remove('active');
        document.getElementById('msg-menu-overlay').classList.add('d-none');
    },

    closeHeaderMenu() {
        state.chatMenuOpen = false;
        document.getElementById('chat-header-menu').classList.remove('active');
    },

    closeMsgContextMenu() {
        state.msgMenuOpen = false;
        document.getElementById('msg-menu-overlay').classList.add('d-none');
    },

    openProfileModal() {
        uiCallbacks.closeAllMenus(); // Tutup menu yang mungkin masih terbuka
        state.profileEditMode = false;
        state.tempFullName = state.myFullName;
        document.getElementById('profile-modal-avatar').textContent = getInitials(state.myFullName);
        document.getElementById('profile-modal-name').textContent = state.myFullName;
        // Username bersifat tetap (untuk login) — hanya ditampilkan, tidak bisa diubah
        document.getElementById('profile-modal-username').textContent = `@${state.myUsername}`;
        document.getElementById('edit-profile-fullname-input').value = state.tempFullName;
        uiCallbacks.updateProfileEditMode();
        document.getElementById('profile-modal').classList.remove('d-none');
    },

    updateProfileEditMode() {
        const input = document.getElementById('edit-profile-fullname-input');
        const btn = document.getElementById('btn-toggle-edit-fullname');
        const cancelBtn = document.getElementById('btn-cancel-edit-fullname');
        const isEdit = state.profileEditMode;
        input.disabled = !isEdit;
        // Ikon: pensil = mode lihat, centang = mode edit
        btn.querySelector('.btn-inline-edit-icon').textContent = isEdit ? 'check' : 'edit_square';
        btn.setAttribute('aria-label', isEdit ? 'Simpan perubahan nama lengkap' : 'Edit nama lengkap');
        cancelBtn.classList.toggle('d-none', !isEdit);
    },

    closeProfileModal() {
        document.getElementById('profile-modal').classList.add('d-none');
    },

    openAddFriendModal() {
        uiCallbacks.closeAllMenus(); // Tutup menu sidebar
        document.getElementById('search-friend-input').value = ''; // Mulai dari bersih
        document.getElementById('add-friend-modal').classList.remove('d-none');
        document.getElementById('search-friend-input').focus();
    },

    closeAddFriendModal() {
        document.getElementById('add-friend-modal').classList.add('d-none');
    },

    updateProfileModalLoading(loading) {
        const btn = document.getElementById('btn-toggle-edit-fullname');
        const input = document.getElementById('edit-profile-fullname-input');
        const cancelBtn = document.getElementById('btn-cancel-edit-fullname');
        if (loading) {
            btn.disabled = true;
            input.disabled = true;
            cancelBtn.disabled = true;
            btn.querySelector('.btn-inline-edit-icon').classList.add('d-none');
            btn.querySelector('.spinner').classList.remove('d-none');
        } else {
            btn.disabled = false;
            input.disabled = !state.profileEditMode;
            cancelBtn.disabled = false;
            btn.querySelector('.btn-inline-edit-icon').classList.remove('d-none');
            btn.querySelector('.spinner').classList.add('d-none');
        }
    },

    scrollToBottom() {
        setTimeout(() => {
            const box = document.getElementById('chat-messages-container');
            if (box) box.scrollTop = box.scrollHeight;
        }, 100);
    }
};

// --- Theme controls UI synchronization ---
function updateThemeControlsUI() {
    const themeIcon = document.getElementById('theme-menu-icon');
    const themeText = document.getElementById('theme-menu-text');
    if (state.darkTheme) {
        themeIcon.textContent = 'light_mode';
        themeText.textContent = 'Tema Terang';
    } else {
        themeIcon.textContent = 'dark_mode';
        themeText.textContent = 'Tema Gelap';
    }

    const labels = {
        'blue': 'Biru',
        'green': 'Hijau',
        'red': 'Merah'
    };
    const accentLabel = document.getElementById('accent-dropdown-label');
    if (accentLabel) {
        accentLabel.textContent = labels[state.accentColor] || 'Pilih Warna';
    }

    document.querySelectorAll('#accent-dropdown-list .dropdown-item').forEach(el => {
        if (el.dataset.accent === state.accentColor) {
            el.classList.add('active');
        } else {
            el.classList.remove('active');
        }
    });
}

// --- Context Menu Handler ---
function handleLongPress(event, msg) {
    state.selectedMsg = msg;
    
    const touch = event.touches ? event.touches[0] : event;
    let x = touch.clientX;
    let y = touch.clientY;

    const menuWidth = 220; 
    const menuHeight = 150; 
    
    if (x + (menuWidth / 2) > window.innerWidth) x = window.innerWidth - (menuWidth / 2) - 10;
    if (x - (menuWidth / 2) < 0) x = (menuWidth / 2) + 10;
    if (y - menuHeight < 0) y = menuHeight + 10;

    state.msgMenuX = x;
    state.msgMenuY = y;
    state.msgMenuOpen = true;

    const overlay = document.getElementById('msg-menu-overlay');
    const menuBox = document.getElementById('msg-menu-box');
    
    menuBox.style.left = `${x}px`;
    menuBox.style.top = `${y}px`;
    
    const deleteBtn = document.getElementById('menu-delete-msg');
    if (msg.pengirimUid === state.myUid) {
        deleteBtn.classList.remove('d-none');
    } else {
        deleteBtn.classList.add('d-none');
    }

    // Sorot reaksi yang sudah terpasang pada pesan ini
    document.querySelectorAll('.reaction-btn').forEach(btn => {
        btn.classList.toggle('active', msg.reaksi === btn.dataset.emoji);
    });

    overlay.classList.remove('d-none');
}

// --- Event Listeners Setup ---
function initEventListeners() {
    // 1. Modals & Dialog
    document.getElementById('btn-dialog-cancel').addEventListener('click', () => {
        uiCallbacks.closeModal();
    });
    
    document.getElementById('btn-dialog-confirm').addEventListener('click', () => {
        if (state.modal.onConfirm) state.modal.onConfirm();
        uiCallbacks.closeModal();
    });

    // 2. Auth Page Toggles & Navigation
    document.getElementById('link-to-register').addEventListener('click', (e) => {
        e.preventDefault();
        uiCallbacks.setAuthMode('register');
    });

    document.getElementById('link-to-login').addEventListener('click', (e) => {
        e.preventDefault();
        uiCallbacks.setAuthMode('login');
    });

    // 3. Password Visibilities
    document.getElementById('btn-toggle-login-password').addEventListener('click', function() {
        const input = document.getElementById('login-password');
        if (input.type === 'password') {
            input.type = 'text';
            this.textContent = 'visibility_off';
        } else {
            input.type = 'password';
            this.textContent = 'visibility';
        }
    });

    document.getElementById('btn-toggle-reg-password').addEventListener('click', function() {
        const input = document.getElementById('reg-password');
        if (input.type === 'password') {
            input.type = 'text';
            this.textContent = 'visibility_off';
        } else {
            input.type = 'password';
            this.textContent = 'visibility';
        }
    });

    // 4. Authentications Action buttons
    const triggerLogin = () => {
        const username = document.getElementById('login-username').value;
        const pass = document.getElementById('login-password').value;
        handleLogin(state, username, pass, uiCallbacks);
    };

    document.getElementById('btn-login').addEventListener('click', triggerLogin);
    
    document.getElementById('login-username').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') triggerLogin();
    });
    document.getElementById('login-password').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') triggerLogin();
    });

    const triggerRegister = () => {
        const fullName = document.getElementById('reg-fullname').value;
        const username = document.getElementById('reg-username').value;
        const pass = document.getElementById('reg-password').value;
        handleRegister(state, fullName, username, pass, uiCallbacks);
    };

    document.getElementById('btn-register').addEventListener('click', triggerRegister);
    
    document.getElementById('reg-fullname').addEventListener('keydown', (e) => { if (e.key === 'Enter') triggerRegister(); });
    document.getElementById('reg-username').addEventListener('keydown', (e) => { if (e.key === 'Enter') triggerRegister(); });
    document.getElementById('reg-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') triggerRegister(); });

    // 5. Chat Page: Add Friend
    const triggerAddFriend = () => {
        const searchInput = document.getElementById('search-friend-input');
        addFriend(state, searchInput.value, uiCallbacks);
    };
    
    document.getElementById('btn-add-friend').addEventListener('click', triggerAddFriend);
    document.getElementById('search-friend-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') triggerAddFriend();
    });

    // 6. Chat Page: Menus & Popups
    // Klik ikon profil (avatar) di kiri atas sidebar membuka modal profil
    document.getElementById('my-avatar').addEventListener('click', () => {
        uiCallbacks.openProfileModal();
    });

    // Dukungan keyboard (Enter/Space) untuk membuka modal profil
    document.getElementById('my-avatar').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            uiCallbacks.openProfileModal();
        }
    });

    document.getElementById('btn-sidebar-menu').addEventListener('click', (e) => {
        e.stopPropagation();
        state.menuOpen = !state.menuOpen;
        const sidebarMenu = document.getElementById('sidebar-menu');
        if (state.menuOpen) {
            sidebarMenu.classList.add('active');
        } else {
            sidebarMenu.classList.remove('active');
        }
    });

    document.getElementById('menu-add-friend').addEventListener('click', () => {
        uiCallbacks.openAddFriendModal();
    });

    document.getElementById('menu-toggle-theme').addEventListener('click', () => {
        toggleTheme(state);
        updateThemeControlsUI();
        
        // Close menu directly with its transition
        state.menuOpen = false;
        document.getElementById('sidebar-menu').classList.remove('active');
    });

    document.getElementById('btn-accent-dropdown').addEventListener('click', (e) => {
        e.stopPropagation();
        state.accentMenuOpen = !state.accentMenuOpen;
        const accentList = document.getElementById('accent-dropdown-list');
        if (state.accentMenuOpen) {
            accentList.classList.add('active');
        } else {
            accentList.classList.remove('active');
        }
    });

    document.querySelectorAll('#accent-dropdown-list .dropdown-item').forEach(item => {
        item.addEventListener('click', function(e) {
            e.stopPropagation();
            const color = this.dataset.accent;
            changeAccent(state, color);
            updateThemeControlsUI();
            uiCallbacks.closeAllMenus();
        });
    });

    // 7. Chat Header Actions
    document.getElementById('btn-back-to-sidebar').addEventListener('click', () => {
        handleBack(state, uiCallbacks);
    });

    document.getElementById('btn-chat-header-menu').addEventListener('click', (e) => {
        e.stopPropagation();
        state.chatMenuOpen = !state.chatMenuOpen;
        const headerMenu = document.getElementById('chat-header-menu');
        if (state.chatMenuOpen) {
            headerMenu.classList.add('active');
        } else {
            headerMenu.classList.remove('active');
        }
    });

    document.getElementById('menu-clear-chat').addEventListener('click', () => {
        clearChat(state, uiCallbacks);
    });

    document.getElementById('menu-toggle-search').addEventListener('click', () => {
        state.searchActive = !state.searchActive;

        if (state.searchActive) {
            document.getElementById('chat-search-bar-header').classList.remove('d-none');
            document.getElementById('active-friend-search-status').classList.remove('d-none');
            document.getElementById('search-menu-icon').textContent = 'search_off';
            document.getElementById('search-menu-text').textContent = 'Batal Cari';
            document.getElementById('chat-search-query-input').focus();
        } else {
            uiCallbacks.resetSearch();
        }
        uiCallbacks.closeHeaderMenu();
    });

    document.querySelectorAll('.btn-change-accent').forEach(dot => {
        dot.addEventListener('click', function() {
            const color = this.dataset.accent;
            changeAccent(state, color);
            updateThemeControlsUI();
            uiCallbacks.closeHeaderMenu();
        });
    });

    // Search Query input handler
    document.getElementById('chat-search-query-input').addEventListener('input', function() {
        state.searchQuery = this.value;
        uiCallbacks.renderMessages();
    });

    // 8. Message Context Menu Reactions and Actions
    document.getElementById('msg-menu-overlay').addEventListener('click', () => {
        uiCallbacks.closeMsgContextMenu();
    });

    document.querySelectorAll('.reaction-btn').forEach(btn => {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            addReaction(state, this.dataset.emoji, uiCallbacks);
        });
    });

    document.getElementById('menu-reply-msg').addEventListener('click', () => {
        replyMessage(state, uiCallbacks);
    });

    document.getElementById('menu-delete-msg').addEventListener('click', () => {
        deleteMessage(state, uiCallbacks);
    });

    // Event delegation on message list container for long press/right click context menu
    const messageListContainer = document.getElementById('messages-list-items');
    
    // Right click
    messageListContainer.addEventListener('contextmenu', (e) => {
        const msgEl = e.target.closest('.message');
        if (!msgEl) return;
        e.preventDefault();
        const msgId = msgEl.dataset.id;
        const msg = state.messages.find(m => m.id === msgId);
        if (msg) {
            handleLongPress(e, msg);
        }
    });

    // Touch events for mobile long press
    let touchTimer = null;
    messageListContainer.addEventListener('touchstart', (e) => {
        const msgEl = e.target.closest('.message');
        if (!msgEl) return;
        
        if (touchTimer) clearTimeout(touchTimer);
        
        touchTimer = setTimeout(() => {
            const msgId = msgEl.dataset.id;
            const msg = state.messages.find(m => m.id === msgId);
            if (msg) {
                handleLongPress(e, msg);
            }
        }, 600);
    }, { passive: true });

    messageListContainer.addEventListener('touchend', () => {
        if (touchTimer) clearTimeout(touchTimer);
    });

    messageListContainer.addEventListener('touchmove', () => {
        if (touchTimer) clearTimeout(touchTimer);
    });

    // 9. Input and Send Message Row
    const triggerSendMessage = () => {
        const input = document.getElementById('chat-input-text');
        sendMessage(state, input.value, uiCallbacks);
        input.focus(); // pertahankan fokus agar bisa terus mengetik
    };

    document.getElementById('btn-send-message').addEventListener('click', triggerSendMessage);
    document.getElementById('chat-input-text').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') triggerSendMessage();
    });

    document.getElementById('btn-cancel-reply').addEventListener('click', () => {
        state.replyingTo = null;
        uiCallbacks.updateReplyPreview();
    });

    // 10. Profile Modals
    document.getElementById('btn-close-profile-modal').addEventListener('click', () => {
        uiCallbacks.closeProfileModal();
    });

    // Klik area gelap di luar modal profil menutupnya
    document.getElementById('profile-modal').addEventListener('click', (e) => {
        if (e.target === document.getElementById('profile-modal')) {
            uiCallbacks.closeProfileModal();
        }
    });

    // Modal tambah teman: tombol tutup (X) + klik area gelap
    document.getElementById('btn-close-add-friend').addEventListener('click', () => {
        uiCallbacks.closeAddFriendModal();
    });
    document.getElementById('add-friend-modal').addEventListener('click', (e) => {
        if (e.target === document.getElementById('add-friend-modal')) {
            uiCallbacks.closeAddFriendModal();
        }
    });

    // Alur simpan nama lengkap: validasi + konfirmasi sebelum menyimpan
    const requestSaveFullName = () => {
        const val = document.getElementById('edit-profile-fullname-input').value;
        if (!val.trim()) {
            uiCallbacks.showToast('Nama lengkap tidak boleh kosong.');
            return;
        }
        uiCallbacks.showModal('Simpan Perubahan', 'Apakah Anda yakin ingin menyimpan perubahan nama lengkap?', 'confirm', async () => {
            await saveProfile(state, val, uiCallbacks);
        });
    };

    // Tombol mode edit nama lengkap: "Edit" <-> "Simpan Perubahan"
    document.getElementById('btn-toggle-edit-fullname').addEventListener('click', () => {
        if (!state.profileEditMode) {
            state.profileEditMode = true;
            uiCallbacks.updateProfileEditMode();
            document.getElementById('edit-profile-fullname-input').focus();
        } else {
            requestSaveFullName();
        }
    });

    // Enter di input nama lengkap memicu alur simpan yang sama (saat mode edit aktif)
    document.getElementById('edit-profile-fullname-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && state.profileEditMode) {
            e.preventDefault();
            requestSaveFullName();
        }
    });

    // Batal edit: keluar dari mode edit tanpa menyimpan (nilai input dikembalikan)
    document.getElementById('btn-cancel-edit-fullname').addEventListener('click', () => {
        state.profileEditMode = false;
        document.getElementById('edit-profile-fullname-input').value = state.myFullName;
        uiCallbacks.updateProfileEditMode();
    });

    // Logout dipindah ke modal profil (modal baru ditutup setelah konfirmasi)
    document.getElementById('btn-logout-profile').addEventListener('click', () => {
        handleLogout(state, uiCallbacks, { stopChatListener, stopFriendPreviews });
    });

    // 11. Click outside helper to close menus
    window.addEventListener('click', (e) => {
        const btnSidebarMenu = document.getElementById('btn-sidebar-menu');
        const sidebarMenu = document.getElementById('sidebar-menu');
        if (state.menuOpen && !btnSidebarMenu.contains(e.target) && !sidebarMenu.contains(e.target)) {
            state.menuOpen = false;
            sidebarMenu.classList.remove('active');
        }

        const btnAccentDropdown = document.getElementById('btn-accent-dropdown');
        const accentDropdownList = document.getElementById('accent-dropdown-list');
        if (state.accentMenuOpen && !btnAccentDropdown.contains(e.target) && !accentDropdownList.contains(e.target)) {
            state.accentMenuOpen = false;
            accentDropdownList.classList.remove('active');
        }

        const btnChatHeaderMenu = document.getElementById('btn-chat-header-menu');
        const chatHeaderMenu = document.getElementById('chat-header-menu');
        if (state.chatMenuOpen && !btnChatHeaderMenu.contains(e.target) && !chatHeaderMenu.contains(e.target)) {
            uiCallbacks.closeHeaderMenu();
        }
    });

    // 12. Tombol Escape menutup menu/modal yang sedang terbuka
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;

        if (state.modal.show) {
            uiCallbacks.closeModal();
            return;
        }
        if (state.msgMenuOpen) {
            uiCallbacks.closeMsgContextMenu();
            return;
        }
        if (state.chatMenuOpen) {
            uiCallbacks.closeHeaderMenu();
            return;
        }
        if (state.menuOpen || state.accentMenuOpen) {
            uiCallbacks.closeAllMenus();
            return;
        }
        if (!document.getElementById('profile-modal').classList.contains('d-none')) {
            uiCallbacks.closeProfileModal();
            return;
        }
        if (!document.getElementById('add-friend-modal').classList.contains('d-none')) {
            uiCallbacks.closeAddFriendModal();
        }
    });
}

// --- App Initialization ---
function init() {
    // Load local config
    initTheme(state);
    updateThemeControlsUI();
    
    // Bind listeners
    initEventListeners();
    
    // Listen to Firebase Auth state
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            state.myUid = user.uid;
            try {
                const data = await fetchUserProfile(user.uid);
                if (data) {
                    state.myUsername = data.username;
                    state.myFullName = data.nama_lengkap;

                    uiCallbacks.updateMyProfileUI();
                    uiCallbacks.setCurrentPage('chat');
                    uiCallbacks.renderActiveFriendHeader();
                    uiCallbacks.updateChatLayoutView();
                    await loadFriendList(state, uiCallbacks);
                } else {
                    uiCallbacks.setCurrentPage('auth');
                }
            } catch (err) {
                console.error("Gagal inisialisasi user data:", err);
                uiCallbacks.setCurrentPage('auth');
            }
        } else {
            uiCallbacks.setCurrentPage('auth');
        }
    });

    // Mobile popstate responsive handling
    // Popstate menangani back DAN forward: baca event.state untuk tahu
    // halaman mana yang dituju ({view:'chat'} => halaman chat).
    window.addEventListener('popstate', (e) => {
        if (state.currentPage !== 'chat') return;
        const nextView = e.state && e.state.view === 'chat' ? 'chat' : 'sidebar';
        if (state.view !== nextView) {
            state.view = nextView;
            uiCallbacks.updateChatLayoutView();
        }
    });
}

// Run app init
init();
