/**
 * Presence registry (spec §7.2): who is online or away in each workspace, counted per connection so a
 * user with two tabs stays online until the last tab closes. Pure and in-process; the Redis bus
 * adapter (Phase 5) shares it across nodes.
 */
export type PresenceStatus = "online" | "away";

type UserPresence = { status: PresenceStatus; connections: Set<string> };

export type PresenceChange = { userId: string; status: PresenceStatus | "offline" };

export class PresenceRegistry {
  private readonly workspaces = new Map<string, Map<string, UserPresence>>();

  /** Records a connection's status in a workspace; returns the change to broadcast, if any. */
  set(
    workspaceId: string,
    userId: string,
    connectionId: string,
    status: PresenceStatus,
  ): PresenceChange | null {
    const users = this.users(workspaceId);
    const current = users.get(userId);
    if (!current) {
      users.set(userId, { status, connections: new Set([connectionId]) });
      return { userId, status };
    }
    current.connections.add(connectionId);
    if (current.status === status) return null;
    // "online" from any connection wins over "away" from another.
    if (status === "away" && current.status === "online" && current.connections.size > 1)
      return null;
    current.status = status;
    return { userId, status };
  }

  /** Drops a connection from a workspace; returns "offline" when it was the user's last one. */
  leave(workspaceId: string, userId: string, connectionId: string): PresenceChange | null {
    const users = this.workspaces.get(workspaceId);
    const current = users?.get(userId);
    if (!users || !current) return null;
    if (!current.connections.delete(connectionId)) return null;
    if (current.connections.size > 0) return null;
    users.delete(userId);
    if (users.size === 0) this.workspaces.delete(workspaceId);
    return { userId, status: "offline" };
  }

  snapshot(workspaceId: string): Array<{ userId: string; status: PresenceStatus }> {
    const users = this.workspaces.get(workspaceId);
    if (!users) return [];
    return [...users.entries()].map(([userId, p]) => ({ userId, status: p.status }));
  }

  private users(workspaceId: string): Map<string, UserPresence> {
    let users = this.workspaces.get(workspaceId);
    if (!users) {
      users = new Map();
      this.workspaces.set(workspaceId, users);
    }
    return users;
  }
}
