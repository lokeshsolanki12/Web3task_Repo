import json
import os
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Dict, Optional

from flask import Flask, jsonify
from flask_sock import Sock
from flask_cors import CORS

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}})
sock = Sock(app)

DEFAULT_VIDEO_ID = os.getenv("DEFAULT_VIDEO_ID", "M7lc1UVf-VE")
rooms: Dict[str, "Room"] = {}
connections: Dict[str, object] = {}
lock = threading.RLock()

@dataclass
class Participant:
    user_id: str
    username: str
    role: str
    ws: object
    joined_at: float = field(default_factory=time.time)


class Room:
    """In-memory watch room. Designed as an MVP; replace storage/broadcast with
    Redis + a persistent DB when horizontally scaling."""

    def __init__(self, room_id: str):
        self.room_id = room_id
        self.participants: Dict[str, Participant] = {}
        self.video_id = DEFAULT_VIDEO_ID
        self.play_state = "paused"
        self.current_time = 0.0
        self.state_updated_at = time.time()

    def add_participant(self, participant: Participant):
        self.participants[participant.user_id] = participant

    def remove_participant(self, user_id: str):
        self.participants.pop(user_id, None)

    def get(self, user_id: str) -> Optional[Participant]:
        return self.participants.get(user_id)

    def has_permission(self, user_id: str, action: str) -> bool:
        user = self.get(user_id)
        if not user:
            return False
        if action in {"play", "pause", "seek", "change_video"}:
            return user.role in {"host", "moderator"}
        if action in {"assign_role", "remove_participant", "transfer_host"}:
            return user.role == "host"
        return False

    def participant_list(self):
        return [
            {
                "userId": p.user_id,
                "username": p.username,
                "role": p.role,
            }
            for p in sorted(self.participants.values(), key=lambda x: x.joined_at)
        ]

    def effective_current_time(self):
        if self.play_state == "playing":
            return max(0.0, self.current_time + (time.time() - self.state_updated_at))
        return max(0.0, self.current_time)

    def state_payload(self):
        return {
            "playState": self.play_state,
            "currentTime": self.effective_current_time(),
            "videoId": self.video_id,
            "serverTime": time.time(),
        }

    def broadcast(self, message, exclude=None):
        dead = []
        payload = json.dumps(message)
        for user_id, participant in list(self.participants.items()):
            if user_id == exclude:
                continue
            try:
                participant.ws.send(payload)
            except Exception:
                dead.append(user_id)
        for user_id in dead:
            self.remove_participant(user_id)

    def broadcast_participants(self):
        self.broadcast({
            "type": "participants",
            "participants": self.participant_list(),
        })


def clean_room_if_empty(room_id):
    room = rooms.get(room_id)
    if room and not room.participants:
        rooms.pop(room_id, None)


def send(ws, message):
    try:
        ws.send(json.dumps(message))
    except Exception:
        pass


def error(ws, message):
    send(ws, {"type": "error", "message": message})


def normalize_room_id(value):
    value = str(value or "").strip().upper()
    return "".join(ch for ch in value if ch.isalnum())[:12]


def normalize_username(value):
    value = " ".join(str(value or "").strip().split())
    return value[:30] or "Guest"


def extract_video_id(value):
    """Accept a raw YouTube ID or common YouTube URL forms."""
    value = str(value or "").strip()
    if not value:
        return None

    if len(value) == 11 and "/" not in value and " " not in value:
        return value

    import re
    patterns = [
        r"(?:v=|youtu\.be/|youtube\.com/embed/|youtube\.com/shorts/)([A-Za-z0-9_-]{11})",
    ]
    for pattern in patterns:
        match = re.search(pattern, value)
        if match:
            return match.group(1)
    return None


def require_joined(ws, room_id, user_id):
    room = rooms.get(room_id)
    if not room:
        error(ws, "Room does not exist.")
        return None, None
    user = room.get(user_id)
    if not user:
        error(ws, "You are not a member of this room.")
        return None, None
    return room, user


@app.get("/api/health")
def health():
    return jsonify({
        "status": "ok",
        "rooms": len(rooms),
        "service": "youtube-watch-party-backend",
    })


@app.get("/")
def index():
    return jsonify({
        "service": "YouTube Watch Party API",
        "websocket": "/ws",
        "health": "/api/health",
    })


@sock.route("/ws")
def websocket(ws):
    user_id = str(uuid.uuid4())
    joined_room_id = None

    try:
        first_raw = ws.receive()
        if first_raw is None:
            return

        try:
            first = json.loads(first_raw)
        except json.JSONDecodeError:
            error(ws, "First message must be valid JSON.")
            return

        if first.get("type") != "join_room":
            error(ws, "First event must be join_room.")
            return

        room_id = normalize_room_id(first.get("roomId"))
        username = normalize_username(first.get("username"))

        if not room_id:
            error(ws, "Room code is required.")
            return

        with lock:
            room = rooms.get(room_id)
            if room is None:
                room = Room(room_id)
                rooms[room_id] = room
                role = "host"
            else:
                role = "participant"

            participant = Participant(
                user_id=user_id,
                username=username,
                role=role,
                ws=ws,
            )
            room.add_participant(participant)
            connections[user_id] = ws
            joined_room_id = room_id

            snapshot = {
                "type": "joined",
                "userId": user_id,
                "roomId": room_id,
                "username": username,
                "role": role,
                "state": room.state_payload(),
                "participants": room.participant_list(),
            }

        send(ws, snapshot)
        room.broadcast({
            "type": "user_joined",
            "username": username,
            "userId": user_id,
            "role": role,
            "participants": room.participant_list(),
        }, exclude=user_id)

        while True:
            raw = ws.receive()
            if raw is None:
                break

            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                error(ws, "Invalid JSON message.")
                continue

            event = message.get("type")
            room, user = require_joined(ws, joined_room_id, user_id)
            if not room:
                break

            # Client requested to leave.
            if event == "leave_room":
                break

            if event in {"play", "pause"}:
                if not room.has_permission(user_id, event):
                    error(ws, f"{event} requires Host or Moderator permission.")
                    continue

                room.current_time = max(0.0, float(message.get("time", room.effective_current_time())))
                room.play_state = "playing" if event == "play" else "paused"
                room.state_updated_at = time.time()
                room.broadcast({
                    "type": "sync_state",
                    **room.state_payload(),
                    "sourceUserId": user_id,
                    "action": event,
                })
                continue

            if event == "seek":
                if not room.has_permission(user_id, "seek"):
                    error(ws, "Seek requires Host or Moderator permission.")
                    continue

                try:
                    new_time = max(0.0, float(message.get("time", 0)))
                except (TypeError, ValueError):
                    error(ws, "Invalid seek time.")
                    continue

                room.current_time = new_time
                room.state_updated_at = time.time()
                room.broadcast({
                    "type": "sync_state",
                    **room.state_payload(),
                    "sourceUserId": user_id,
                    "action": "seek",
                })
                continue

            if event == "change_video":
                if not room.has_permission(user_id, "change_video"):
                    error(ws, "Changing the video requires Host or Moderator permission.")
                    continue

                video_id = extract_video_id(message.get("videoId"))
                if not video_id:
                    error(ws, "Enter a valid YouTube URL or 11-character video ID.")
                    continue

                room.video_id = video_id
                room.current_time = 0.0
                room.play_state = "paused"
                room.state_updated_at = time.time()
                room.broadcast({
                    "type": "sync_state",
                    **room.state_payload(),
                    "sourceUserId": user_id,
                    "action": "change_video",
                })
                continue

            if event == "assign_role":
                if not room.has_permission(user_id, "assign_role"):
                    error(ws, "Only the Host can assign roles.")
                    continue

                target_id = str(message.get("userId", ""))
                target_role = str(message.get("role", "")).lower()
                target = room.get(target_id)

                if not target:
                    error(ws, "Participant not found.")
                    continue
                if target_id == user_id:
                    error(ws, "Host cannot change their own role.")
                    continue
                if target_role not in {"participant", "moderator"}:
                    error(ws, "Role must be participant or moderator.")
                    continue

                target.role = target_role
                room.broadcast({
                    "type": "role_assigned",
                    "userId": target.user_id,
                    "username": target.username,
                    "role": target.role,
                    "participants": room.participant_list(),
                })
                continue

            if event == "remove_participant":
                if not room.has_permission(user_id, "remove_participant"):
                    error(ws, "Only the Host can remove participants.")
                    continue

                target_id = str(message.get("userId", ""))
                target = room.get(target_id)
                if not target:
                    error(ws, "Participant not found.")
                    continue
                if target_id == user_id:
                    error(ws, "Host cannot remove themselves.")
                    continue

                send(target.ws, {
                    "type": "removed",
                    "message": "You were removed from the room by the Host.",
                })
                room.remove_participant(target_id)
                connections.pop(target_id, None)
                room.broadcast({
                    "type": "participant_removed",
                    "userId": target_id,
                    "participants": room.participant_list(),
                })
                continue

            if event == "transfer_host":
                if not room.has_permission(user_id, "transfer_host"):
                    error(ws, "Only the Host can transfer the Host role.")
                    continue

                target_id = str(message.get("userId", ""))
                target = room.get(target_id)
                if not target or target_id == user_id:
                    error(ws, "Invalid host transfer target.")
                    continue

                user.role = "participant"
                target.role = "host"
                room.broadcast({
                    "type": "role_assigned",
                    "userId": target.user_id,
                    "username": target.username,
                    "role": target.role,
                    "participants": room.participant_list(),
                })
                room.broadcast({
                    "type": "role_assigned",
                    "userId": user.user_id,
                    "username": user.username,
                    "role": user.role,
                    "participants": room.participant_list(),
                })
                continue

            if event == "request_control":
                requested_action = str(message.get("action", ""))
                allowed_requests = {"play", "pause", "seek", "change_video"}
                if requested_action not in allowed_requests:
                    error(ws, "Unsupported control request.")
                    continue

                approvers = [
                    p.ws for p in room.participants.values()
                    if p.role in {"host", "moderator"} and p.user_id != user_id
                ]
                request_payload = {
                    "type": "control_request",
                    "requestId": str(uuid.uuid4()),
                    "userId": user.user_id,
                    "username": user.username,
                    "action": requested_action,
                    "time": message.get("time"),
                    "videoId": message.get("videoId"),
                }
                for approver_ws in approvers:
                    send(approver_ws, request_payload)
                send(ws, {
                    "type": "request_status",
                    "message": "Request sent to Host/Moderator.",
                })
                continue

            error(ws, f"Unknown event: {event}")

    except Exception as exc:
        app.logger.exception("WebSocket error: %s", exc)
    finally:
        with lock:
            if joined_room_id and joined_room_id in rooms:
                room = rooms[joined_room_id]
                leaving_user = room.get(user_id)
                if leaving_user:
                    was_host = leaving_user.role == "host"
                    room.remove_participant(user_id)
                    connections.pop(user_id, None)

                    # Keep a room usable if the Host disconnects unexpectedly.
                    if was_host and room.participants:
                        new_host = min(room.participants.values(), key=lambda p: p.joined_at)
                        new_host.role = "host"
                        room.broadcast({
                            "type": "host_transferred",
                            "userId": new_host.user_id,
                            "username": new_host.username,
                            "participants": room.participant_list(),
                            "message": "The previous Host disconnected. Host role was transferred.",
                        })

                    if room.participants:
                        room.broadcast({
                            "type": "user_left",
                            "username": leaving_user.username,
                            "userId": leaving_user.user_id,
                            "participants": room.participant_list(),
                        })
                    else:
                        clean_room_if_empty(joined_room_id)


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    # Development server. For production on Render, use the command in render.yaml.
    app.run(host="0.0.0.0", port=port, debug=True)
