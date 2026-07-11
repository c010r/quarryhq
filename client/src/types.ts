export type Plan = 'free' | 'premium';
export type Subscription = 'none' | 'premium' | 'team';
export interface User {
  id: number; username: string; name?: string | null; picture?: string | null;
  plan?: Plan;                    // plan efectivo (incluye premium por asiento de equipo)
  subscription?: Subscription;    // lo contratado por este usuario
  premium_until?: string | null;
  is_admin?: number;              // puede gestionar códigos de invitación
  email?: string | null;
  email_verified?: number;
}
export interface InviteCode {
  id: number; code: string; trial_days: number; max_uses: number; used_count: number;
  created_at: string; redeemed_by: string | null;
}
export interface AdminUser {
  id: number; username: string; email: string | null; name: string | null;
  plan: 'free' | 'premium' | 'team'; premium_until: string | null;
  is_admin: number; email_verified: number; has_google: number;
  team_owner: string | null; created_at: string;
}
export interface AdminPayment {
  id: number; user_id: number; username: string; email: string | null;
  plan: string; amount_cents: number; currency: string; days: number;
  method: string; created_at: string;
}
export interface PlanLimits { boards: number; notes: number; channels: number; cardsPerBoard: number; noteVersions: number }
export interface PlanUsage { boards: number; notes: number; channels: number }
export type TeamInfo =
  | { role: 'owner'; members: { id: number; username: string }[]; max_members: number }
  | { role: 'member'; owner: string }
  | null;
export interface Board { id: number; name: string }
export interface List { id: number; board_id: number; name: string; position: number; cards: Card[] }
export interface Card {
  id: number; list_id: number; title: string; description: string;
  labels: string; position: number; list_name?: string; board_id?: number;
  due_date: string | null; completed: number;
  checklist_total?: number; checklist_done?: number; member_names?: string | null;
}
export interface ChecklistItem { id: number; card_id: number; text: string; done: number; position: number }
export interface BoardRule { id: number; board_id: number; list_id: number; action: string; param: string; list_name?: string }
export interface NoteVersion { id: number; title: string; created_at: string; size: number }
export interface Template { id: number; name: string; content: string }
export interface TagCount { tag: string; count: number }
export interface Reaction { message_id: number; emoji: string; count: number; mine: number }
export interface ScheduledMessage { id: number; content: string; send_at: string }
export interface Note { id: number; title: string; content: string; updated_at: string }
export interface NoteMeta { id: number; title: string; updated_at: string }
export interface Channel { id: number; name: string; card_id?: number | null; card_title?: string | null }
export interface Message {
  id: number; channel_id: number; user_id: number; content: string; created_at: string; username: string;
  parent_id?: number | null; edited_at?: string | null; pinned?: number; reply_count?: number;
}

export interface Backlink {
  source_type: 'note' | 'card' | 'message';
  source_id: number;
  kind: string;
  label: string | null;
  channel_id?: number | null;
}

export interface LinkedNote { id: number; title: string; link_id: number; kind: string }

export interface GraphNode { key: string; type: 'note' | 'card' | 'channel'; id: number; label: string }
export interface GraphEdge { source: string; target: string; kind: string }

export interface SearchResults {
  cards: { id: number; title: string; board_id: number }[];
  notes: { id: number; title: string }[];
  messages: { id: number; content: string; channel_id: number; channel_name: string; username: string }[];
  channels: { id: number; name: string }[];
}

export const LABEL_COLORS: Record<string, string> = {
  violeta: '#8b5cf6', azul: '#3b82f6', verde: '#22c55e',
  amarillo: '#eab308', rojo: '#ef4444', naranja: '#f97316',
};
