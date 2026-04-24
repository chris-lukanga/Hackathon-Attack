// --- SUPABASE INIT ---
const SUPABASE_URL = 'https://xyqbljkosxmbprsclmuv.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_qejE9tsa_Qsfh5CbZwgAdg_ZVvj8lLe';
const client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// State
let myUserId = null;
let myUsername = null;
let currentRoomId = null;
let currentPartnerUsername = null;
let currentPartnerId = null;
let realtimeSubscription = null;
let pendingMessage = false;

// DOM elements
const authScreen = document.getElementById('auth-screen');
const chatScreen = document.getElementById('chat-screen');
const errorMsgDiv = document.getElementById('error-msg');
const messagesContainer = document.getElementById('messages-container');
const messagesList = document.getElementById('messages-list');
const welcomeMessageDiv = document.getElementById('welcome-message');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const usersContainer = document.getElementById('users-container');
const userSearch = document.getElementById('user-search');
const partnerNameSpan = document.getElementById('partner-name');
const currentUserDisplay = document.getElementById('current-user-display');
const menuToggle = document.getElementById('menuToggleBtn');
const sidebarOverlay = document.getElementById('sidebar-overlay');
const sidebar = document.getElementById('sidebar');

// Helper functions
function showToast(msg, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.className = `toast ${type} show`;
    setTimeout(() => toast.classList.remove('show'), 2800);
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function formatTime(date) {
    return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
}

function scrollToBottom() {
    if (messagesContainer) messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function updateSendButtonState() {
    const hasText = messageInput.value.trim().length > 0;
    const hasRoom = !!currentRoomId;
    sendBtn.disabled = !hasText || !hasRoom;
    messageInput.disabled = !hasRoom;
    if (!hasRoom) messageInput.placeholder = "Select a user to start typing...";
    else messageInput.placeholder = `Message ${currentPartnerUsername || 'user'}...`;
}

function renderMessage(text, isMine, timestamp = new Date()) {
    const wrapper = document.createElement('div');
    wrapper.className = `message-wrapper ${isMine ? 'sent' : 'received'}`;
    wrapper.innerHTML = `
        <div class="message-bubble">${escapeHtml(text)}</div>
        <div class="message-time">${formatTime(timestamp)}</div>
    `;
    messagesList.appendChild(wrapper);
    scrollToBottom();
}

// Load message history
async function loadMessageHistory() {
    if (!currentRoomId) return;
    try {
        const { data: messages, error } = await client
            .from('messages')
            .select('*')
            .eq('room_id', currentRoomId)
            .order('created_at', { ascending: true });
        if (error) throw error;
        messagesList.innerHTML = '';
        if (messages.length === 0 && welcomeMessageDiv) welcomeMessageDiv.style.display = 'flex';
        else if (welcomeMessageDiv) welcomeMessageDiv.style.display = 'none';
        
        messages.forEach(msg => {
            renderMessage(msg.content, msg.user_id === myUserId, new Date(msg.created_at));
        });
    } catch (err) {
        console.error("history error", err);
    }
}

// Realtime subscription
function subscribeToRealtime() {
    if (realtimeSubscription) client.removeChannel(realtimeSubscription);
    if (!currentRoomId) return;
    realtimeSubscription = client.channel(`room:${currentRoomId}`)
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'messages',
            filter: `room_id=eq.${currentRoomId}`
        }, payload => {
            if (payload.new.user_id !== myUserId) {
                renderMessage(payload.new.content, false, new Date(payload.new.created_at));
            }
        }).subscribe();
}

// Send message (reliable)
async function sendMessage() {
    const text = messageInput.value.trim();
    if (!text || !currentRoomId || pendingMessage) return;
    pendingMessage = true;
    messageInput.value = '';
    updateSendButtonState();
    renderMessage(text, true, new Date());
    try {
        const { error } = await client.from('messages').insert({
            room_id: currentRoomId,
            user_id: myUserId,
            content: text
        });
        if (error) throw error;
    } catch (err) {
        console.error("send error", err);
        showToast("Failed to send. Try again.", "error");
    } finally {
        pendingMessage = false;
        updateSendButtonState();
        messageInput.focus();
    }
}

// Start or open chat
window.startChatWithUser = async function(targetUsername, targetId) {
    if (!targetUsername || targetUsername === myUsername) return;
    currentPartnerUsername = targetUsername;
    currentPartnerId = targetId;
    partnerNameSpan.textContent = targetUsername;
    // highlight active user in sidebar
    document.querySelectorAll('.user-item').forEach(item => {
        item.classList.toggle('active', item.dataset.userId === targetId);
    });
    try {
        const { data: myRooms } = await client.from('participants').select('room_id').eq('user_id', myUserId);
        const { data: theirRooms } = await client.from('participants').select('room_id').eq('user_id', targetId);
        const myRoomIds = myRooms.map(r => r.room_id);
        const shared = theirRooms.find(r => myRoomIds.includes(r.room_id));
        if (shared) {
            currentRoomId = shared.room_id;
        } else {
            const { data: newRoom, error: roomErr } = await client.from('rooms').insert({}).select().single();
            if (roomErr) throw roomErr;
            currentRoomId = newRoom.id;
            await client.from('participants').insert([
                { room_id: currentRoomId, user_id: myUserId },
                { room_id: currentRoomId, user_id: targetId }
            ]);
        }
        // unlock UI
        updateSendButtonState();
        if (welcomeMessageDiv) welcomeMessageDiv.style.display = 'none';
        await loadMessageHistory();
        subscribeToRealtime();
        messageInput.focus();
        // close drawer on mobile after selection
        if (window.innerWidth <= 780) closeDrawer();
    } catch (err) {
        console.error(err);
        showToast("Could not start conversation.", "error");
    }
};

// Load users list
async function loadUsers(searchTerm = '') {
    try {
        let query = client.from('profiles').select('id, username');
        if (searchTerm) query = query.ilike('username', `%${searchTerm}%`);
        const { data: profiles, error } = await query.neq('id', myUserId).order('username');
        if (error) throw error;
        renderUsersList(profiles || []);
    } catch (err) {
        console.warn("load users", err);
    }
}

function renderUsersList(users) {
    if (!usersContainer) return;
    if (users.length === 0) {
        usersContainer.innerHTML = `<div class="empty-state"><i class="fas fa-user-slash"></i> No users found</div>`;
        return;
    }
    usersContainer.innerHTML = users.map(user => `
        <div class="user-item ${currentPartnerUsername === user.username ? 'active' : ''}" 
             data-user-id="${user.id}" data-username="${user.username}"
             onclick="startChatWithUser('${escapeHtml(user.username)}', '${user.id}')">
            <div class="avatar-small"><i class="fas fa-user"></i></div>
            <div class="user-item-info">
                <div class="user-item-name">${escapeHtml(user.username)}</div>
            </div>
        </div>
    `).join('');
}

// Debounce helper
function debounce(fn, delay) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}

// Auth handlers
async function handleAuth(action) {
    const user = document.getElementById('username').value.trim();
    const pass = document.getElementById('password').value;
    if (!user || !pass) return showToast("Fill username & password", "error");
    if (user.length < 3) return showToast("Username min 3 chars", "error");
    const emailTrick = `${user}@chatapp.local`;
    errorMsgDiv.innerText = "";
    showToast("Authenticating...", "info");
    let response;
    if (action === 'signup') {
        response = await client.auth.signUp({ email: emailTrick, password: pass, options: { data: { username: user } } });
    } else {
        response = await client.auth.signInWithPassword({ email: emailTrick, password: pass });
    }
    if (response.error) {
        showToast(response.error.message, "error");
        errorMsgDiv.innerText = response.error.message;
    } else {
        myUserId = response.data.user.id;
        myUsername = user;
        authScreen.style.display = 'none';
        chatScreen.style.display = 'flex';
        currentUserDisplay.innerText = user;
        await loadUsers();
        setInterval(() => loadUsers(userSearch.value.trim()), 35000);
        showToast(`Welcome ${user} ✨`, "success");
        closeDrawer();
    }
}

function logoutAndReload() {
    client.auth.signOut();
    location.reload();
}

// Drawer controls
function closeDrawer() {
    sidebar.classList.remove('open');
    sidebarOverlay.classList.remove('active');
}
function openDrawer() {
    sidebar.classList.add('open');
    sidebarOverlay.classList.add('active');
}

// --- Event Listeners ---
document.getElementById('login-btn')?.addEventListener('click', () => handleAuth('login'));
document.getElementById('signup-btn')?.addEventListener('click', () => handleAuth('signup'));
document.getElementById('logout-btn')?.addEventListener('click', logoutAndReload);
sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });
messageInput.addEventListener('input', updateSendButtonState);
if (userSearch) {
    userSearch.addEventListener('input', debounce((e) => loadUsers(e.target.value.trim()), 300));
}
menuToggle?.addEventListener('click', openDrawer);
sidebarOverlay?.addEventListener('click', closeDrawer);

// Check existing session on load
(async () => {
    const { data: { session } } = await client.auth.getSession();
    if (session?.user) {
        myUserId = session.user.id;
        myUsername = session.user.user_metadata?.username || session.user.email?.split('@')[0] || "User";
        authScreen.style.display = 'none';
        chatScreen.style.display = 'flex';
        currentUserDisplay.innerText = myUsername;
        await loadUsers();
        setInterval(() => loadUsers(userSearch?.value.trim() || ''), 35000);
    }
})();

// Close drawer on window resize if desktop
window.addEventListener('resize', () => { if (window.innerWidth > 780) closeDrawer(); });