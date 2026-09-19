import React, { useEffect, useMemo, useRef, useState } from "react";

const productionApiUrl = "https://youtube-watch-party-api-1gvx.onrender.com";
const isLocalDevelopment = ["localhost", "127.0.0.1"].includes(window.location.hostname);
const API_URL = import.meta.env.VITE_API_URL || (isLocalDevelopment ? "http://localhost:5000" : productionApiUrl);
const WS_URL = import.meta.env.VITE_WS_URL || API_URL.replace(/^http/, "ws") + "/ws";

function makeRoomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function getRoomFromUrl() {
  return new URLSearchParams(window.location.search).get("room") || "";
}

function roleLabel(role) {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function App() {
  const [screen, setScreen] = useState(getRoomFromUrl() ? "join" : "home");
  const [roomId, setRoomId] = useState(getRoomFromUrl());
  const [username, setUsername] = useState("");
  const [joinedRoom, setJoinedRoom] = useState("");
  const [myUserId, setMyUserId] = useState("");
  const [myRole, setMyRole] = useState("");
  const [participants, setParticipants] = useState([]);
  const [videoId, setVideoId] = useState("M7lc1UVf-VE");
  const [videoInput, setVideoInput] = useState("");
  const [playState, setPlayState] = useState("paused");
  const [currentTime, setCurrentTime] = useState(0);
  const [messages, setMessages] = useState([]);
  const [notice, setNotice] = useState("");
  const [controlRequests, setControlRequests] = useState([]);
  const [connected, setConnected] = useState(false);

  const wsRef = useRef(null);
  const playerRef = useRef(null);
  const playerReadyRef = useRef(false);
  const suppressEventsRef = useRef(false);
  const intervalRef = useRef(null);
  const stateRef = useRef({ playState: "paused", currentTime: 0, serverTime: Date.now() / 1000 });

  const canControl = myRole === "host" || myRole === "moderator";
  const isHost = myRole === "host";

  const roomLink = useMemo(() => {
    if (!joinedRoom) return "";
    return `${window.location.origin}/?room=${encodeURIComponent(joinedRoom)}`;
  }, [joinedRoom]);

  function showNotice(text) {
    setNotice(text);
    window.clearTimeout(showNotice.timer);
    showNotice.timer = window.setTimeout(() => setNotice(""), 3500);
  }

  function send(event) {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(event));
    } else {
      showNotice("WebSocket is not connected.");
    }
  }

  function loadYouTubeApi() {
    if (window.YT?.Player) return Promise.resolve();

    return new Promise((resolve) => {
      const existing = document.getElementById("youtube-iframe-api");
      if (existing) {
        const poll = setInterval(() => {
          if (window.YT?.Player) {
            clearInterval(poll);
            resolve();
          }
        }, 100);
        return;
      }

      window.onYouTubeIframeAPIReady = () => resolve();
      const script = document.createElement("script");
      script.id = "youtube-iframe-api";
      script.src = "https://www.youtube.com/iframe_api";
      document.body.appendChild(script);
    });
  }

  async function initPlayer(initialVideoId) {
    await loadYouTubeApi();

    const createPlayer = () => {
      if (playerRef.current) {
        try {
          playerRef.current.destroy();
        } catch {}
      }

      playerReadyRef.current = false;
      playerRef.current = new window.YT.Player("youtube-player", {
        videoId: initialVideoId,
        playerVars: {
          autoplay: 0,
          controls: 1,
          rel: 0,
          modestbranding: 1
        },
        events: {
          onReady: () => {
            playerReadyRef.current = true;
            applyServerState(stateRef.current);
          },
          onStateChange: (event) => {
            if (suppressEventsRef.current || !canControl) return;

            if (event.data === window.YT.PlayerState.PLAYING) {
              send({ type: "play", time: playerRef.current.getCurrentTime() });
            } else if (event.data === window.YT.PlayerState.PAUSED) {
              send({ type: "pause", time: playerRef.current.getCurrentTime() });
            }
          }
        }
      });
    };

    if (document.getElementById("youtube-player")) createPlayer();
  }

  function applyServerState(state) {
    stateRef.current = state;
    setPlayState(state.playState);
    setCurrentTime(state.currentTime || 0);

    if (!playerReadyRef.current || !playerRef.current) return;

    suppressEventsRef.current = true;
    try {
      const localTarget = state.playState === "playing"
        ? (state.currentTime || 0) + (Date.now() / 1000 - (state.serverTime || Date.now() / 1000))
        : (state.currentTime || 0);

      if (Math.abs((playerRef.current.getCurrentTime?.() || 0) - localTarget) > 1.0) {
        playerRef.current.seekTo(Math.max(0, localTarget), true);
      }

      if (state.playState === "playing") {
        playerRef.current.playVideo();
      } else {
        playerRef.current.pauseVideo();
      }
    } finally {
      window.setTimeout(() => {
        suppressEventsRef.current = false;
      }, 250);
    }
  }

  function connect() {
    const cleanRoom = roomId.trim().toUpperCase();
    const cleanName = username.trim();

    if (!cleanRoom || !cleanName) {
      showNotice("Enter both room code and username.");
      return;
    }

    if (wsRef.current) wsRef.current.close();

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      send({
        type: "join_room",
        roomId: cleanRoom,
        username: cleanName
      });
    };

    ws.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (message.type === "joined") {
        setScreen("room");
        setJoinedRoom(message.roomId);
        setMyUserId(message.userId);
        setMyRole(message.role);
        setParticipants(message.participants || []);
        setVideoId(message.state.videoId);
        setPlayState(message.state.playState);
        setCurrentTime(message.state.currentTime || 0);
        stateRef.current = message.state;
        window.history.replaceState({}, "", `/?room=${encodeURIComponent(message.roomId)}`);
        showNotice(`Joined ${message.roomId} as ${roleLabel(message.role)}.`);
        initPlayer(message.state.videoId);
      }

      if (message.type === "sync_state") {
        setVideoId(message.videoId);
        applyServerState(message);
        if (message.videoId !== videoId) initPlayer(message.videoId);
      }

      if (message.type === "participants" || message.type === "user_joined" || message.type === "user_left") {
        setParticipants(message.participants || []);
      }

      if (message.type === "role_assigned" || message.type === "host_transferred") {
        setParticipants(message.participants || []);
        if (message.userId === myUserId) setMyRole(message.role);
        showNotice(message.message || `${message.username} is now ${roleLabel(message.role)}.`);
      }

      if (message.type === "participant_removed") {
        setParticipants(message.participants || []);
      }

      if (message.type === "removed") {
        showNotice(message.message);
        ws.close();
        setConnected(false);
        setScreen("home");
      }

      if (message.type === "error") showNotice(message.message);

      if (message.type === "control_request") {
        setControlRequests((current) => [...current, message]);
        showNotice(`${message.username} requested ${message.action}.`);
      }

      if (message.type === "request_status") showNotice(message.message);
    };

    ws.onclose = () => {
      setConnected(false);
    };

    ws.onerror = () => {
      setConnected(false);
      showNotice("Unable to connect to the backend WebSocket.");
    };
  }

  useEffect(() => {
    intervalRef.current = window.setInterval(() => {
      if (playerReadyRef.current && playerRef.current && screen === "room") {
        const localTime = playerRef.current.getCurrentTime?.() || 0;
        setCurrentTime(localTime);
      }
    }, 1000);

    return () => {
      window.clearInterval(intervalRef.current);
    };
  }, [screen]);

  useEffect(() => () => {
    wsRef.current?.close();
    playerRef.current?.destroy?.();
  }, []);

  function createRoom() {
    const code = makeRoomCode();
    setRoomId(code);
    setScreen("join");
  }

  function leaveRoom() {
    send({ type: "leave_room", roomId: joinedRoom });
    wsRef.current?.close();
    setConnected(false);
    setScreen("home");
    setJoinedRoom("");
    setMyUserId("");
    setMyRole("");
    setParticipants([]);
    window.history.replaceState({}, "", "/");
  }

  function updateVideo() {
    if (!canControl) {
      send({ type: "request_control", action: "change_video", videoId: videoInput });
      return;
    }
    send({ type: "change_video", videoId: videoInput });
    setVideoInput("");
  }

  function togglePlayback() {
    if (!canControl) {
      send({
        type: "request_control",
        action: playState === "playing" ? "pause" : "play",
        time: playerRef.current?.getCurrentTime?.() || currentTime
      });
      return;
    }

    if (playState === "playing") {
      send({ type: "pause", time: playerRef.current?.getCurrentTime?.() || currentTime });
    } else {
      send({ type: "play", time: playerRef.current?.getCurrentTime?.() || currentTime });
    }
  }

  function seek(delta) {
    const target = Math.max(0, (playerRef.current?.getCurrentTime?.() || currentTime) + delta);
    if (!canControl) {
      send({ type: "request_control", action: "seek", time: target });
      return;
    }
    send({ type: "seek", time: target });
  }

  function assignRole(userId, role) {
    send({ type: "assign_role", userId, role });
  }

  function removeParticipant(userId) {
    if (window.confirm("Remove this participant from the room?")) {
      send({ type: "remove_participant", userId });
    }
  }

  function transferHost(userId) {
    if (window.confirm("Transfer Host role to this participant?")) {
      send({ type: "transfer_host", userId });
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <div className="brand">Watch<span>Party</span></div>
          <div className="tagline">Real-time YouTube collaboration</div>
        </div>
        {screen === "room" && (
          <div className="top-actions">
            <span className={connected ? "status online" : "status"}>{connected ? "● Live" : "● Offline"}</span>
            <button className="secondary" onClick={leaveRoom}>Leave Room</button>
          </div>
        )}
      </header>

      {notice && <div className="toast">{notice}</div>}

      {screen === "home" && (
        <main className="landing">
          <section className="hero-card">
            <div className="eyebrow">Intern Assignment • WebSocket MVP</div>
            <h1>Watch YouTube<br /><span>together, in sync.</span></h1>
            <p>
              Create a private watch room, share the code, and keep playback synchronized
              for every participant.
            </p>
            <div className="hero-actions">
              <button className="primary" onClick={createRoom}>Create Watch Party</button>
              <button className="secondary large" onClick={() => setScreen("join")}>Join Existing Room</button>
            </div>
            <div className="feature-row">
              <div><b>⚡ Real-time</b><small>WebSocket sync</small></div>
              <div><b>🔐 Role-based</b><small>Host / Moderator / Participant</small></div>
              <div><b>▶ YouTube</b><small>IFrame Player API</small></div>
            </div>
          </section>
        </main>
      )}

      {screen === "join" && (
        <main className="join-page">
          <section className="join-card">
            <div className="eyebrow">Enter the party</div>
            <h2>{roomId ? "Join Watch Room" : "Create or Join"}</h2>
            <p className="muted">The first person in a new room automatically becomes Host.</p>

            <label>Room code</label>
            <input
              value={roomId}
              onChange={(e) => setRoomId(e.target.value.toUpperCase())}
              placeholder="e.g. A1B2C3"
              maxLength={12}
            />

            <label>Your name</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. Lokesh"
              maxLength={30}
              onKeyDown={(e) => e.key === "Enter" && connect()}
            />

            <button className="primary full" onClick={connect}>Join Room</button>
            <button className="text-button" onClick={() => setScreen("home")}>← Back</button>
          </section>
        </main>
      )}

      {screen === "room" && (
        <main className="room-layout">
          <section className="main-column">
            <div className="room-heading">
              <div>
                <div className="eyebrow">Room</div>
                <h2>{joinedRoom}</h2>
              </div>
              <button className="secondary" onClick={() => navigator.clipboard?.writeText(roomLink)}>
                Copy Invite Link
              </button>
            </div>

            <div className="video-card">
              <div id="youtube-player" className="youtube-player" />
              <div className="control-bar">
                <button onClick={() => seek(-10)} title="Back 10 seconds">↶ 10s</button>
                <button className="play-button" onClick={togglePlayback}>
                  {playState === "playing" ? "❚❚" : "▶"}
                </button>
                <button onClick={() => seek(10)} title="Forward 10 seconds">10s ↷</button>
                <div className="time-label">{Math.floor(currentTime)}s</div>
                {!canControl && <span className="request-hint">Participant controls require approval</span>}
              </div>
            </div>

            <div className="video-change">
              <div>
                <b>Change YouTube video</b>
                <small>Paste a YouTube URL or video ID</small>
              </div>
              <input
                value={videoInput}
                onChange={(e) => setVideoInput(e.target.value)}
                placeholder="https://youtube.com/watch?v=..."
                onKeyDown={(e) => e.key === "Enter" && updateVideo()}
              />
              <button className="primary" onClick={updateVideo}>
                {canControl ? "Change Video" : "Request Change"}
              </button>
            </div>

            {isHost && controlRequests.length > 0 && (
              <div className="requests-card">
                <div className="section-title">Pending control requests</div>
                {controlRequests.map((request) => (
                  <div className="request-row" key={request.requestId}>
                    <span><b>{request.username}</b> requested <b>{request.action}</b></span>
                    <button className="secondary" onClick={() => {
                      if (request.action === "seek") send({ type: "seek", time: request.time });
                      else if (request.action === "change_video") send({ type: "change_video", videoId: request.videoId });
                      else send({ type: request.action, time: request.time });
                      setControlRequests((items) => items.filter((x) => x.requestId !== request.requestId));
                    }}>Approve</button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <aside className="sidebar">
            <div className="sidebar-card">
              <div className="section-title">
                <span>Participants</span>
                <span className="count">{participants.length}</span>
              </div>

              <div className="participant-list">
                {participants.map((person) => (
                  <div className="participant" key={person.userId}>
                    <div className="avatar">{person.username.slice(0, 1).toUpperCase()}</div>
                    <div className="participant-info">
                      <b>{person.username}{person.userId === myUserId ? " (You)" : ""}</b>
                      <span className={`role role-${person.role}`}>{roleLabel(person.role)}</span>
                    </div>

                    {isHost && person.userId !== myUserId && (
                      <div className="participant-actions">
                        <select
                          value={person.role}
                          onChange={(e) => assignRole(person.userId, e.target.value)}
                        >
                          <option value="participant">Participant</option>
                          <option value="moderator">Moderator</option>
                        </select>
                        <button onClick={() => transferHost(person.userId)} title="Transfer Host">👑</button>
                        <button onClick={() => removeParticipant(person.userId)} title="Remove">×</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="sidebar-card info-card">
              <div className="section-title">Permissions</div>
              <div className="permission"><span>Host</span><small>Full control + roles</small></div>
              <div className="permission"><span>Moderator</span><small>Playback + video</small></div>
              <div className="permission"><span>Participant</span><small>Watch + request</small></div>
            </div>

            <div className="sidebar-card share-card">
              <div className="section-title">Invite</div>
              <p>Share this room link with your friends.</p>
              <code>{roomLink}</code>
              <button className="secondary full" onClick={() => navigator.clipboard?.writeText(roomLink)}>Copy Link</button>
            </div>
          </aside>
        </main>
      )}
    </div>
  );
}

export default App;
