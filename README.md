# YouTube Watch Party

A full-stack internship assignment implementation based on the supplied requirements.

## Stack

- Frontend: React + Vite
- Backend: Python Flask
- Real-time: native WebSocket via Flask-Sock
- Video: YouTube IFrame Player API
- Storage: in-memory room state for the MVP
- Deployment target: Render

The assignment explicitly requires room-based real-time synchronization, WebSockets, YouTube integration and role-based permissions. The implementation covers those requirements. The supplied guide allows Python on the backend and SQLite/PostgreSQL/MongoDB as optional database choices for the MVP. fileciteturn0file0L45-L63

## Features implemented

- Create a watch room; creator becomes Host.
- Join an existing room using a room code or invite URL.
- Real-time play/pause synchronization.
- Real-time seek synchronization.
- Real-time YouTube video changes.
- Host / Moderator / Participant roles.
- Host can promote/demote participants.
- Host can remove participants.
- Host can transfer Host role.
- Backend validates permissions before processing playback/role events.
- Participant control requests are sent to Host/Moderator for approval.
- Participant list and roles update live.
- Automatic Host transfer if the current Host disconnects unexpectedly.
- Health endpoint for deployment checks.

These map to the required event and permission model in the assignment, including `join_room`, `sync_state`, `play`, `pause`, `seek`, `change_video`, `assign_role`, `remove_participant`, and participant/role updates. fileciteturn0file0L64-L158

## Project structure

```text
youtube-watch-party/
├── backend/
│   ├── app.py
│   ├── requirements.txt
│   └── render.yaml
├── frontend/
│   ├── index.html
│   ├── package.json
│   ├── vite.config.js
│   └── src/
│       ├── App.jsx
│       ├── main.jsx
│       └── styles.css
├── .gitignore
├── README.md
└── render.yaml
```

## Local setup

### 1. Backend

Python 3.10+ is recommended.

```bash
cd backend

python -m venv venv

# Windows
venv\Scripts\activate

# Linux/macOS
source venv/bin/activate

pip install -r requirements.txt

python app.py
```

Backend:
`http://localhost:5000`

Health check:
`http://localhost:5000/api/health`

WebSocket:
`ws://localhost:5000/ws`

### 2. Frontend

Open another terminal:

```bash
cd frontend
npm install
npm run dev
```

Frontend:
`http://localhost:5173`

Open two browser tabs, create a room in one and join the same room in the other.

## Frontend environment variables

Create `frontend/.env` if your backend is not on localhost:

```env
VITE_API_URL=https://your-backend.onrender.com
VITE_WS_URL=wss://your-backend.onrender.com/ws
```

For local development the application automatically uses:

```text
HTTP: http://localhost:5000
WS:   ws://localhost:5000/ws
```

## Render deployment

The assignment requires a publicly reachable deployment and names Render, Vercel, Netlify and Railway as acceptable platforms. It also requires the live URL to be included in the README. fileciteturn0file0L160-L170

### Backend

Create a Render Web Service from the repository.

- Root Directory: `backend`
- Build Command: `pip install -r requirements.txt`
- Start Command:

```bash
gunicorn --worker-class geventwebsocket.gunicorn.workers.GeventWebSocketWorker --workers 1 --bind 0.0.0.0:$PORT app:app
```

After deployment, copy the backend URL.

### Frontend

Create a second Render Web Service or Static Site for `frontend`.

Build command:

```bash
npm install && npm run build
```

Publish directory:

```text
dist
```

Set:

```env
VITE_API_URL=https://YOUR-BACKEND.onrender.com
VITE_WS_URL=wss://YOUR-BACKEND.onrender.com/ws
```

Then deploy.

> Important: Vite environment variables are compiled into the frontend at build time. Set them before the frontend build.

## Production notes

This MVP keeps rooms in process memory. Therefore:

- Restarting the backend removes active rooms.
- One Render WebSocket process is intentionally used for this assignment.
- Horizontal scaling requires shared state and a pub/sub layer.

The supplied assignment lists Redis Pub/Sub, load balancing and multiple WebSocket instances as the scalability direction for larger deployments. fileciteturn0file0L195-L203

## Code walkthrough

### WebSocket flow

1. React opens `ws://.../ws`.
2. Client sends `join_room`.
3. Backend creates the room if needed.
4. The first user receives `host`; later users receive `participant`.
5. Backend sends the current video/playback state.
6. Host/Moderator playback actions are validated by the backend.
7. Valid actions update room state and are broadcast to every connected participant.
8. React receives `sync_state` and updates the YouTube IFrame Player.
9. Role changes and participant changes are broadcast to all clients.

### Why the backend validates permissions

UI buttons are not security. A participant could manually send a WebSocket message, so the server checks the user's role before every privileged operation.

Examples:

- `play`, `pause`, `seek`, `change_video`: Host/Moderator.
- `assign_role`, `remove_participant`, `transfer_host`: Host only.

### YouTube integration

The frontend loads the official YouTube IFrame API and creates a `YT.Player`. Server state controls `playVideo`, `pauseVideo`, and `seekTo`.

### Synchronization

The server stores:

```text
playState
videoId
currentTime
stateUpdatedAt
```

When a room is playing, a late client calculates the current playback position using the server timestamp, reducing visible drift.

## Assignment coverage

The supplied guide requires:

- working application
- README
- architecture overview
- code walkthrough readiness
- public deployment
- host role management
- participant removal
- restricted playback
- playback/seek/video synchronization
- optional chat

This implementation covers the required non-chat features; chat remains optional. fileciteturn0file0L178-L194

## Architecture

```text
                 ┌──────────────────────┐
                 │      React/Vite       │
                 │  Room UI + YouTube   │
                 │      IFrame API      │
                 └──────────┬───────────┘
                            │
                     WebSocket /ws
                            │
                 ┌──────────▼───────────┐
                 │      Flask-Sock      │
                 │ WebSocket Controller │
                 └──────────┬───────────┘
                            │
                 ┌──────────▼───────────┐
                 │       Room class     │
                 │ participants + state │
                 │ permission checks    │
                 └──────────┬───────────┘
                            │
                    in-memory MVP state
```

## Live URL

After deployment, replace this line with the real public URL:

```text
Live URL: https://YOUR-FRONTEND.onrender.com
```

Do not claim a deployment is live until you have actually deployed it.

## Future improvements

- PostgreSQL for persistent rooms.
- Redis Pub/Sub for multi-instance WebSocket broadcasting.
- Authentication.
- Persistent room state.
- Text chat.
- Reactions.
- More robust reconnect/resync.
- Rate limiting and stronger input validation.

