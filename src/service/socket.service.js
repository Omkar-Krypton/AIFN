import io from "socket.io-client";
import { API_URL } from "../config/api";

let socket;

export const connectSocket = (onForceLogout, token) => {
  if (socket) {
    if (!socket.connected) {
      socket.auth = { token };
      socket.connect();
    }
    return;
  }

  socket = io(API_URL, {
    withCredentials: true,
    transports: ["polling", "websocket"],
    auth: { token },
  });

  socket.on("connect", () => {
    console.log("Socket connected:", socket.id);
  });

  socket.on("force-logout", async (data) => {
    console.log("Force logout received:", data);
    if (onForceLogout) {
      await onForceLogout(data);
    }
  });

  socket.on("disconnect", () => {
    console.log("Socket disconnected");
  });

  socket.on("connect_error", (err) => {
    console.error("Socket connection error:", err);
  });
};

export const disconnectSocket = () => {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
};

export const getSocket = () => socket;

