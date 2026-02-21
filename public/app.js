/* global marked, hljs */

const messagesEl = document.getElementById("messages");
const form = document.getElementById("chat-form");
const input = document.getElementById("input");
const sessionListEl = document.getElementById("session-list");
const newSessionBtn = document.getElementById("new-session");
const heartbeatBanner = document.getElementById("heartbeat-banner");

// Configure marked
marked.setOptions({
  highlight: function (code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  },
});

// WebSocket connection
const protocol = location.protocol === "https:" ? "wss:" : "ws:";
const ws = new WebSocket(`${protocol}//${location.host}`);

let currentSessionId = null;
let assistantEl = null;
let assistantText = "";
let sending = false;

ws.onopen = () => {
  ws.send(JSON.stringify({ method: "session.list" }));
};

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);

  switch (msg.event) {
    case "session.list":
      renderSessionList(msg.data.sessions);
      break;

    case "session.created":
      currentSessionId = msg.data.sessionId;
      messagesEl.innerHTML = "";
      ws.send(JSON.stringify({ method: "session.list" }));
      break;

    case "chat.history":
      currentSessionId = msg.data.sessionId;
      renderHistory(msg.data.messages);
      break;

    case "chunk":
      if (!assistantEl) {
        assistantEl = addMessage("assistant", "");
        assistantText = "";
      }
      assistantText += msg.data.text;
      assistantEl.innerHTML = marked.parse(assistantText);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      break;

    case "tool_start": {
      const details = document.createElement("details");
      details.className = "tool-block";
      details.id = `tool-${msg.data.name}-${Date.now()}`;
      details.innerHTML =
        `<summary>Tool: ${msg.data.name}</summary>` +
        `<pre>${escapeHtml(JSON.stringify(msg.data.input, null, 2))}</pre>`;
      (assistantEl || messagesEl).appendChild(details);
      break;
    }

    case "tool_end": {
      const blocks = document.querySelectorAll(".tool-block");
      const last = blocks[blocks.length - 1];
      if (last) {
        const resultPre = document.createElement("pre");
        resultPre.textContent = truncate(msg.data.result, 2000);
        last.appendChild(resultPre);
      }
      break;
    }

    case "done":
      assistantEl = null;
      assistantText = "";
      sending = false;
      input.disabled = false;
      form.querySelector("button").disabled = false;
      currentSessionId = msg.data.sessionId;
      ws.send(JSON.stringify({ method: "session.list" }));
      break;

    case "heartbeat":
      heartbeatBanner.textContent = msg.data.text;
      heartbeatBanner.classList.remove("hidden");
      setTimeout(() => heartbeatBanner.classList.add("hidden"), 10000);
      break;

    case "error":
      addMessage("assistant", `Error: ${msg.data.message}`);
      sending = false;
      input.disabled = false;
      form.querySelector("button").disabled = false;
      break;
  }
};

// Send message
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || sending) return;

  sending = true;
  input.disabled = true;
  form.querySelector("button").disabled = true;

  addMessage("user", text);
  input.value = "";

  ws.send(
    JSON.stringify({
      method: "chat.send",
      params: { text, sessionId: currentSessionId },
    })
  );
});

// Enter to send, Shift+Enter for newline
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.dispatchEvent(new Event("submit"));
  }
});

// New session
newSessionBtn.addEventListener("click", () => {
  ws.send(JSON.stringify({ method: "session.create" }));
});

// Dismiss heartbeat banner
heartbeatBanner.addEventListener("click", () => {
  heartbeatBanner.classList.add("hidden");
});

// Helpers

function addMessage(role, content) {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.innerHTML = role === "user" ? escapeHtml(content) : marked.parse(content);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function renderHistory(messages) {
  messagesEl.innerHTML = "";
  for (const msg of messages) {
    const text =
      typeof msg.content === "string"
        ? msg.content
        : msg.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("");
    if (text) addMessage(msg.role, text);
  }
}

function formatSessionLabel(session) {
  const date = new Date(session.lastActive);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (isToday) return `Today ${time}`;
  if (isYesterday) return `Yesterday ${time}`;
  return date.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + time;
}

function renderSessionList(sessions) {
  sessionListEl.innerHTML = "";
  for (const s of sessions) {
    const li = document.createElement("li");
    li.textContent = formatSessionLabel(s);
    li.title = s.id;
    if (s.id === currentSessionId) li.classList.add("active");
    li.addEventListener("click", () => {
      ws.send(
        JSON.stringify({ method: "chat.history", params: { sessionId: s.id } })
      );
    });
    sessionListEl.appendChild(li);
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n... [truncated]";
}
