// --- 1. INITIALIZE CONFIGURATION ---
const SUPABASE_URL = 'https://xyqbljkosxmbprsclmuv.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_qejE9tsa_Qsfh5CbZwgAdg_ZVvj8lLe';
const client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// State Variables
let myUserId = null;
let myUsername = null;
let currentRoomId = null;
let currentPartnerUsername = null;
let realtimeSubscription = null;

// UI Elements
const authScreen = document.getElementById('auth-screen');
const chatScreen = document.getElementById('chat-screen');
const errorMsg = document.getElementById('error-msg');
const messagesContainer = document.getElementById('messages-container');
const messagesList = document.getElementById('messages-list');
const welcomeMessage = document.getElementById('welcome-message');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const usersContainer = document.getElementById('users-container');
const userSearch = document.getElementById('user-search');
const partnerName = document.getElementById('partner-name');

// --- 2. AUTHENTICATION ---
async function handleAuth(action) {
    const user = document.getElementById('username').value.trim();
    const pass = document.getElementById('password').value;
    
    if (!user || !pass) return showToast("Please fill in all fields", "error");
    if (user.length < 3) return showToast("Username must be at least 3 characters", "error");

    const emailTrick = `${user}@yourchat.local`;
    errorMsg.innerText = "";
    showToast("Processing...", "info");

    let response;
    if (action === 'signup') {
        response = await client.auth.signUp({ 
            email: emailTrick, password: pass, options: { data: { username: user } } 
        });
    } else {
        response = await client.auth.signInWithPassword({ email: emailTrick, password: pass });
    }

    if (response.error) {
        showToast(response.error.message, "error");
        errorMsg.innerText = response.error.message;
    } else {
        myUserId = response.data.user.id;
        myUsername = user;
        
        authScreen.style.display = 'none';
        chatScreen.style.display = 'flex';
        document.getElementById('current-user-display').innerText = user;
        
        await loadUsers();
        setInterval(loadUsers, 30000); 
        showToast(`Welcome, ${user}!`, "success");
    }
}

// --- 3. USERS LIST ---
async function loadUsers(searchTerm = '') {
    try {
        let query = client.from('profiles').select('id, username');
        if (searchTerm) query = query.ilike('username', `%${searchTerm}%`);
        
        const { data: profiles, error } = await query
            .neq('id', myUserId)
            .order('username', { ascending: true });

        if (error) throw error;
        renderUsersList(profiles || []);
    } catch (error) {
        console.error("Error loading users:", error);
    }
}

function renderUsersList(users) {
    if (!usersContainer) return;
    if (users.length === 0) {
        usersContainer.innerHTML = `<div class="empty-state">No users found</div>`;
        return;
    }

    usersContainer.innerHTML = users.map(user => `
        <div class="user-item ${currentPartnerUsername === user.username ? 'active' : ''}" 
             onclick="startChatWithUser('${user.username}', '${user.id}')" data-user-id="${user.id}">
            <div class="avatar-small"><i class="fas fa-user"></i></div>
            <div class="user-item-info">
                <div class="user-item-name">${escapeHtml(user.username)}</div>
            </div>
        </div>
    `).join('');
}

if (userSearch) {
    userSearch.addEventListener('input', debounce((e) => loadUsers(e.target.value.trim()), 300));
}

// --- 4. CHAT INITIATION (FIXED - NO EXTERNAL API REQUIRED) ---
async function startChatWithUser(targetUsername, targetId) {
    if (!targetUsername || targetUsername === myUsername) return;

    currentPartnerUsername = targetUsername;
    partnerName.textContent = targetUsername;
    
    document.querySelectorAll('.user-item').forEach(item => {
        item.classList.toggle('active', item.dataset.userId === targetId);
    });

    try {
        // 1. Find existing rooms for both users
        const { data: myRooms } = await client.from('participants').select('room_id').eq('user_id', myUserId);
        const { data: theirRooms } = await client.from('participants').select('room_id').eq('user_id', targetId);

        // 2. Find a shared room
        const myRoomIds = myRooms.map(r => r.room_id);
        const sharedRoom = theirRooms.find(r => myRoomIds.includes(r.room_id));

        if (sharedRoom) {
            currentRoomId = sharedRoom.room_id;
        } else {
            // 3. Create a new room if none exists
            const { data: newRoom, error: roomErr } = await client.from('rooms').insert({}).select().single();
            if (roomErr) throw roomErr;
            currentRoomId = newRoom.id;
            
            await client.from('participants').insert([
                { room_id: currentRoomId, user_id: myUserId },
                { room_id: currentRoomId, user_id: targetId }
            ]);
        }

        // UNLOCK THE INPUT FIELD
        messageInput.disabled = false;
        sendBtn.disabled = false;
        messageInput.placeholder = `Message ${targetUsername}...`;
        messageInput.focus();
        
        messagesList.innerHTML = '';
        welcomeMessage.style.display = 'none';
        
        await loadMessageHistory();
        subscribeToRealtime();
        
    } catch (error) {
        console.error("Error starting chat:", error);
        showToast("Could not start chat.", "error");
    }
}

// --- 5. MESSAGES (FIXED - DIRECT SUPABASE) ---
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
        messages.forEach(msg => {
            renderMessage(msg.content, msg.user_id === myUserId, new Date(msg.created_at));
        });
        scrollToBottom();
    } catch (error) {
        console.error("Failed to load history:", error);
    }
}

async function sendMessage() {
    const text = messageInput.value.trim();
    if (!text || !currentRoomId) return;
    
    messageInput.value = '';
    sendBtn.disabled = true;
    renderMessage(text, true, new Date()); // Optimistic UI
    
    try {
        const { error } = await client.from('messages').insert({
            room_id: currentRoomId,
            user_id: myUserId,
            content: text
        });
        if (error) throw error;
    } catch (error) {
        console.error("Send failed:", error);
        showToast("Message failed to send", "error");
    }
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

function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// --- 6. REALTIME SUBSCRIPTION ---
function subscribeToRealtime() {
    if (realtimeSubscription) client.removeChannel(realtimeSubscription);

    realtimeSubscription = client.channel(`room:${currentRoomId}`)
        .on('postgres_changes', { 
            event: 'INSERT', schema: 'public', table: 'messages', filter: `room_id=eq.${currentRoomId}` 
        }, payload => {
            if (payload.new.user_id !== myUserId) {
                renderMessage(payload.new.content, false, new Date(payload.new.created_at));
            }
        }).subscribe();
}

// --- 7. UTILITIES & EVENTS ---
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatTime(date) {
    return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
}

function debounce(func, wait) {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    };
}

function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    setTimeout(() => toast.classList.remove('show'), 3000);
}

messageInput.addEventListener('keypress', e => {
    if (e.key === 'Enter') { e.preventDefault(); sendMessage(); }
});

messageInput.addEventListener('input', function() {
    sendBtn.disabled = !this.value.trim();
});

document.addEventListener('DOMContentLoaded', async () => {
    const { data: { session } } = await client.auth.getSession();
    if (session?.user) {
        myUserId = session.user.id;
        myUsername = session.user.user_metadata.username;
        
        authScreen.style.display = 'none';
        chatScreen.style.display = 'flex';
        document.getElementById('current-user-display').innerText = myUsername;
        
        await loadUsers();
        setInterval(loadUsers, 30000);
    }
});