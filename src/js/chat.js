import { db } from "./firebase-config.js";
import { 
    ref, set, get, push, off, onValue, query, orderByKey, limitToLast 
} from "https://www.gstatic.com/firebasejs/12.13.0/firebase-database.js";

let activeChatRef = null;
let friendPreviewRefs = [];

export function stopChatListener() {
    if (activeChatRef) {
        console.log("Menghentikan listener chat...");
        off(activeChatRef);
        activeChatRef = null;
    }
}

export function stopFriendPreviews() {
    friendPreviewRefs.forEach(p => p.off());
    friendPreviewRefs = [];
}

// Menjaga preview pesan terakhir setiap teman tetap hidup di daftar teman
// (mirip WhatsApp) dengan membaca hanya 1 pesan terakhir per room.
function startFriendPreviews(state, uiCallbacks) {
    stopFriendPreviews(); // Hindari listener ganda saat daftar dimuat ulang
    state.friends.forEach(friend => {
        const roomId = getRoomId(state.myUid, friend.uid);
        const q = query(ref(db, `pesan_pribadi/${roomId}`), orderByKey(), limitToLast(1));
        const listener = onValue(q, (snap) => {
            let lastMsg = null;
            snap.forEach(child => {
                lastMsg = { ...child.val(), id: child.key };
            });
            friend.lastMsg = lastMsg;
            uiCallbacks.updateFriendPreview(friend.uid, lastMsg);
        });
        friendPreviewRefs.push({ off: () => off(q) });
    });
}

function getRoomId(uidA, uidB) {
    return uidA < uidB ? `${uidA}_${uidB}` : `${uidB}_${uidA}`;
}

export async function loadFriendList(state, uiCallbacks) {
    state.loadingFriends = true;
    uiCallbacks.updateFriendsLoading(true);
    try {
        const snapshot = await get(ref(db, `users/${state.myUid}/daftar_teman`));
        if (!snapshot.exists()) {
            state.friends = [];
            uiCallbacks.renderFriendList();
            startFriendPreviews(state, uiCallbacks);
            return;
        }
        const friendsUids = Object.keys(snapshot.val());
        const tempFriends = [];
        for (let fUid of friendsUids) {
            const userSnapshot = await get(ref(db, 'users/' + fUid));
            if (userSnapshot.exists()) tempFriends.push(userSnapshot.val());
        }
        state.friends = tempFriends;
        uiCallbacks.renderFriendList();
        startFriendPreviews(state, uiCallbacks);
    } catch (e) {
        console.error("Gagal memuat teman:", e);
    } finally {
        state.loadingFriends = false;
        uiCallbacks.updateFriendsLoading(false);
    }
}

export async function addFriend(state, searchUsername, uiCallbacks) {
    const target = searchUsername.trim().toLowerCase();
    if (!target) return;
    if (target === state.myUsername) {
        uiCallbacks.showModal('Peringatan', 'Anda tidak bisa menambahkan diri sendiri.');
        return;
    }

    try {
        const snapshot = await get(ref(db, 'usernames/' + target));
        if (!snapshot.exists()) {
            uiCallbacks.showModal('Tidak Ditemukan', 'Username tersebut tidak terdaftar.');
            return;
        }
        const targetUid = snapshot.val().uid;
        await set(ref(db, `users/${state.myUid}/daftar_teman/${targetUid}`), true);
        await set(ref(db, `users/${targetUid}/daftar_teman/${state.myUid}`), true);
        
        uiCallbacks.clearAddFriendInput();
        uiCallbacks.closeAddFriendModal(); // Tutup modal agar teman baru langsung terlihat
        await loadFriendList(state, uiCallbacks);
        uiCallbacks.showToast('Teman telah ditambahkan.');
    } catch (e) { 
        uiCallbacks.showModal('Error', e.message);
    }
}

export function selectFriend(state, friend, uiCallbacks) {
    state.activeFriendUid = friend.uid;
    state.activeFriendName = friend.nama_lengkap;

    // Sidebar -> chat selalu pindah halaman (pushState) karena kedua area
    // adalah halaman terpisah penuh layar di semua ukuran layar.
    if (state.view === 'sidebar') {
        history.pushState({view: 'chat'}, '');
        state.view = 'chat';
    }
    uiCallbacks.updateChatLayoutView();
    uiCallbacks.renderActiveFriendHeader();
    uiCallbacks.resetSearch();

    bukaRoomChat(state, friend.uid, uiCallbacks);
}

export function handleBack(state, uiCallbacks) {
    if (state.view === 'chat') {
        history.back();
    }
}

export function bukaRoomChat(state, friendUid, uiCallbacks) {
    state.messages = [];
    state.loadingMessages = true;
    uiCallbacks.renderMessages(); // rendering shows loading spinner
    
    stopChatListener();

    const roomId = state.myUid < friendUid ? `${state.myUid}_${friendUid}` : `${friendUid}_${state.myUid}`;
    console.log("Membuka room:", roomId);
    activeChatRef = ref(db, `pesan_pribadi/${roomId}`);

    onValue(activeChatRef, (snapshot) => {
        console.log("Snapshot diterima dari Firebase:", snapshot.exists());
        state.loadingMessages = false;

        if (snapshot.exists()) {
            const data = snapshot.val();
            console.log("Data pesan ditemukan:", Object.keys(data).length, "pesan");
            const temp = [];
            Object.keys(data).forEach(key => {
                const msg = data[key];
                msg.id = key || Math.random().toString(36).substr(2, 9);
                temp.push(msg);
            });
            state.messages = temp;
        } else {
            console.log("Tidak ada pesan di room ini.");
            state.messages = [];
        }
        const wasNearBottom = uiCallbacks.renderMessages();
        if (wasNearBottom) uiCallbacks.scrollToBottom();
    }, (error) => {
        console.error("Firebase error:", error);
        if (state.currentPage !== 'auth') {
            uiCallbacks.showModal('Error Koneksi', 'Gagal memuat pesan: ' + error.message);
        }
        state.loadingMessages = false;
        uiCallbacks.renderMessages();
    });
}

export function sendMessage(state, chatInputText, uiCallbacks) {
    const text = chatInputText.trim();
    if (!text || !activeChatRef) return;
    
    const msgData = {
        pengirimUid: state.myUid,
        teks: text,
        waktu: new Date().toISOString()
    };

    if (state.replyingTo) {
        msgData.balasKe = state.replyingTo;
        state.replyingTo = null;
        uiCallbacks.updateReplyPreview();
    }

    push(activeChatRef, msgData);
    uiCallbacks.clearChatInput();
    uiCallbacks.scrollToBottom();
}

export async function clearChat(state, uiCallbacks) {
    const roomId = getCurrentRoomId(state);
    if (!roomId) return;
    uiCallbacks.showModal('Hapus Chat', 'Apakah Anda yakin ingin menghapus semua pesan di obrolan ini?', 'confirm', async () => {
        try {
            await set(ref(db, `pesan_pribadi/${roomId}`), null);
            state.messages = [];
            state.replyingTo = null;
            uiCallbacks.updateReplyPreview();
            uiCallbacks.renderMessages();
            uiCallbacks.closeHeaderMenu();
        } catch (e) {
            uiCallbacks.showModal('Error', e.message);
        }
    });
}

export function deleteMessage(state, uiCallbacks) {
    const roomId = getCurrentRoomId(state);
    if (!state.selectedMsg || !roomId) return;
    
    // Proteksi: Hanya bisa hapus pesan sendiri
    if (state.selectedMsg.pengirimUid !== state.myUid) {
        uiCallbacks.showModal('Akses Ditolak', 'Anda hanya dapat menghapus pesan Anda sendiri.');
        uiCallbacks.closeMsgContextMenu();
        return;
    }

    const msgId = state.selectedMsg.id;
    uiCallbacks.showModal('Hapus Pesan', 'Apakah Anda yakin ingin menghapus pesan ini?', 'confirm', async () => {
        try {
            await set(ref(db, `pesan_pribadi/${roomId}/${msgId}`), null);
            uiCallbacks.closeMsgContextMenu();
            // Firebase listener will automatically handle sync, but let's filter locally just in case
            state.messages = state.messages.filter(m => m.id !== msgId);
            uiCallbacks.renderMessages();
        } catch (e) {
            uiCallbacks.showModal('Error', 'Gagal menghapus pesan.');
        }
    });
}

export function replyMessage(state, uiCallbacks) {
    if (!state.selectedMsg) return;
    state.replyingTo = {
        teks: state.selectedMsg.teks,
        pengirim: state.selectedMsg.pengirimUid === state.myUid ? 'Anda' : state.activeFriendName
    };
    uiCallbacks.updateReplyPreview();
    uiCallbacks.closeMsgContextMenu();
}

export async function addReaction(state, emoji, uiCallbacks) {
    const roomId = getCurrentRoomId(state);
    if (!state.selectedMsg || !roomId) return;
    const msgId = state.selectedMsg.id;

    // Baca reaksi terbaru dari state (selectedMsg bisa basi bila snapshot baru masuk)
    const current = state.messages.find(m => m.id === msgId);
    const currentReaction = current ? current.reaksi : state.selectedMsg.reaksi;

    // Klik emoji yang sama akan menghapus reaksi (toggle off)
    const newReaction = currentReaction === emoji ? null : emoji;

    try {
        await set(ref(db, `pesan_pribadi/${roomId}/${msgId}/reaksi`), newReaction);
        uiCallbacks.closeMsgContextMenu();
        // Firebase onValue listener akan merender ulang; update lokal sebagai cadangan:
        state.messages = state.messages.map(m =>
            m.id === msgId ? { ...m, reaksi: newReaction } : m
        );
        uiCallbacks.renderMessages();
    } catch (e) {
        uiCallbacks.showModal('Error', 'Gagal mengubah reaksi.');
    }
}

export function getCurrentRoomId(state) {
    if (!state.activeFriendUid) return null;
    return getRoomId(state.myUid, state.activeFriendUid);
}
