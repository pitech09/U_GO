import type { Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { User } from "@shared/schema";
import { verifyAccessToken } from "./auth";

type RealtimeMessage = {
  type: string;
  data: Record<string, unknown>;
};

const clientsByUser = new Map<string, Set<WebSocket>>();

export function attachRealtime(server: HttpServer, getUser: (id: string) => Promise<User | undefined>) {
  const websocketServer = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    let url: URL;
    try {
      url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    } catch {
      socket.destroy();
      return;
    }

    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    const claims = verifyAccessToken(url.searchParams.get("token"));
    if (!claims) {
      socket.destroy();
      return;
    }

    getUser(claims.sub).then((user) => {
      if (!user) {
        socket.destroy();
        return;
      }

      websocketServer.handleUpgrade(request, socket, head, (client) => {
        const clients = clientsByUser.get(user.id) || new Set<WebSocket>();
        clients.add(client);
        clientsByUser.set(user.id, clients);

        client.send(JSON.stringify({
          type: "realtime_connected",
          data: { userId: user.id },
        } satisfies RealtimeMessage));

        client.on("close", () => {
          clients.delete(client);
          if (clients.size === 0) clientsByUser.delete(user.id);
        });

        client.on("error", () => client.close());
      });
    }).catch(() => socket.destroy());
  });

  return websocketServer;
}

export function publishRealtimeEvent(userId: string, message: RealtimeMessage) {
  const clients = clientsByUser.get(userId);
  if (!clients) return;

  const payload = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}
