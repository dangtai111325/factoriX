/**
 * FactoriX IIoT Platform - Real-time WebSocket Stream Client
 * Connects to /stream, manages subscriptions, heartbeats, and live observation dispatch.
 */

import { useEffect, useState } from "react";

export type LiveObservation = {
  type: "latest";
  signal_id: string;
  value: any;
  quality: "GOOD" | "BAD" | "UNCERTAIN" | null;
  timestamp?: number;
};

type Listener = (obs: LiveObservation) => void;
type ConnectionStatusListener = (status: "connected" | "connecting" | "disconnected") => void;

class StreamManager {
  private socket: WebSocket | null = null;
  private subscriptions: Set<string> = new Set();
  private listeners: Set<Listener> = new Set();
  private statusListeners: Set<ConnectionStatusListener> = new Set();
  private status: "connected" | "connecting" | "disconnected" = "disconnected";
  private pingInterval: any = null;
  private reconnectTimer: any = null;
  private retryDelay = 2000;

  constructor() {
    // Lazy connect on first subscription or manual connect
  }

  public getStatus(): "connected" | "connecting" | "disconnected" {
    return this.status;
  }

  public connect(): void {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.setStatus("connecting");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const url = `${protocol}//${host}/stream`;

    try {
      this.socket = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.socket.onopen = () => {
      this.setStatus("connected");
      this.retryDelay = 2000;
      this.sendSubscriptions();

      // Setup ping every 20s
      clearInterval(this.pingInterval);
      this.pingInterval = setInterval(() => {
        if (this.socket?.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({ op: "ping" }));
        }
      }, 20000);
    };

    this.socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "latest" && data.signal_id) {
          data.timestamp = Date.now();
          for (const listener of this.listeners) {
            listener(data as LiveObservation);
          }
        }
      } catch {
        // Ignore non-json or ping responses
      }
    };

    this.socket.onclose = () => {
      this.setStatus("disconnected");
      clearInterval(this.pingInterval);
      this.scheduleReconnect();
    };

    this.socket.onerror = () => {
      this.socket?.close();
    };
  }

  private scheduleReconnect(): void {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 1.5, 30000);
  }

  private setStatus(status: "connected" | "connecting" | "disconnected"): void {
    this.status = status;
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }

  private sendSubscriptions(): void {
    if (this.socket?.readyState === WebSocket.OPEN && this.subscriptions.size > 0) {
      this.socket.send(
        JSON.stringify({
          op: "subscribe",
          signal_ids: Array.from(this.subscriptions),
        })
      );
    }
  }

  public subscribe(signalIds: string[]): void {
    let added = false;
    for (const id of signalIds) {
      if (id && !this.subscriptions.has(id)) {
        this.subscriptions.add(id);
        added = true;
      }
    }
    if (this.status === "disconnected") {
      this.connect();
    } else if (added && this.socket?.readyState === WebSocket.OPEN) {
      this.sendSubscriptions();
    }
  }

  public unsubscribe(signalIds: string[]): void {
    for (const id of signalIds) {
      this.subscriptions.delete(id);
    }
  }

  public addListener(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public onStatusChange(listener: ConnectionStatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => {
      this.statusListeners.delete(listener);
    };
  }
}

export const streamManager = new StreamManager();

/**
 * Hook to subscribe and observe real-time value changes of a single signal
 */
export function useLiveSignal(signalId?: string | null, initialValue?: any, initialQuality?: any) {
  const [liveState, setLiveState] = useState<{
    value: any;
    quality: "GOOD" | "BAD" | "UNCERTAIN" | null;
    updatedAt: number | null;
  }>({
    value: initialValue,
    quality: initialQuality || null,
    updatedAt: null,
  });

  useEffect(() => {
    if (!signalId) return;

    streamManager.subscribe([signalId]);

    const unsubscribe = streamManager.addListener((obs) => {
      if (obs.signal_id === signalId) {
        setLiveState({
          value: obs.value,
          quality: obs.quality,
          updatedAt: obs.timestamp || Date.now(),
        });
      }
    });

    return () => {
      unsubscribe();
    };
  }, [signalId]);

  return liveState;
}

/**
 * Hook to monitor WebSocket connection status (for Header pulse indicator)
 */
export function useStreamStatus() {
  const [status, setStatus] = useState<"connected" | "connecting" | "disconnected">(
    streamManager.getStatus()
  );

  useEffect(() => {
    return streamManager.onStatusChange(setStatus);
  }, []);

  return status;
}
