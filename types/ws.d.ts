declare module "ws" {
  export class WebSocket {
    static readonly OPEN: number;
    readonly readyState: number;
    send(data: string): void;
    close(): void;
    on(event: "close" | "error", listener: () => void): this;
  }

  export class WebSocketServer {
    constructor(options: { noServer: boolean });
    handleUpgrade(
      request: unknown,
      socket: { destroy(): void },
      head: unknown,
      callback: (client: WebSocket) => void,
    ): void;
  }
}
