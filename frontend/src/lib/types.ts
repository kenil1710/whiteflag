export type Pair = { chain: string; address: string };
export type Token = { chain: string; token: string; symbol: string; decimals: number; stolen: string; weight: string };
export type Status = "OPEN" | "SETTLED_FULL" | "SETTLED_PARTIAL" | "SETTLED_NONE";
export type OfferSummary = {
  offer_id: number; incident: string; name: string; protocol: string; status: Status; created_at: number; start: number;
  deadline: number; settle_at: number; settled_at: number; claim_deadline: number; bounty: string; bounty_share_bps: number;
  fraction_ppm: number; owed: string; refunded_at_settle: string; claimed: string; unclaimed_refunded: string;
  n_proofs: number; n_counted: number; n_rejected: number; chains: string[]; meta: Record<string, unknown>;
};
export type Offer = OfferSummary & {
  found: boolean; original_deadline: number; payout_rule: string; claim_window_s: number; exploiters: Pair[]; recoveries: Pair[];
  tokens: Token[]; returned: Record<string, string>; history: { at: number; what: string; [k: string]: unknown }[]; num: string; den: string;
  settled_by: string; refunded_at: number;
  /** what each exploiter address returned, per "chain:token" */
  returned_by: Record<string, Record<string, string>>;
  /** each exploiter address's share of the owed bounty, set at settlement */
  shares: Record<string, string>;
  claims: Record<string, Claim>;
  beneficiaries: Record<string, string>;
};
export type Claim = { amount: string; to: string; at: number };
export type Claimant = { found: boolean; offer_id: number; address: string; listed: boolean; returned: Record<string, string>;
  share: string; beneficiary: string; claim: Claim | null };
export type Credit = { key: string; token: string; amount: string; from: string; to: string; log: number };
export type Proof = {
  proof_id: number; offer_id: number; chain: string; tx_hash: string; submitter: string; submitted_at: number;
  status: "COUNTED" | "REJECTED"; reason: string; detail: string; credits: Credit[]; block: number; block_time: number; from: string; to: string;
};
export type Page<T> = { total: number; offset: number; limit: number; items: T[]; next_offset: number };
export type GateState = {
  offer_id: number; state: string; favorable: boolean; fraction_ppm: number; bounty: string; owed: string; paid: string;
  refunded: string; claim_deadline: number; protocol: string; incident: string; why: string;
};
export type TxProgress = { phase: "signing" | "submitted" | "accepted" | "finalized" | "failed" | "rejected"; hash: string | null; message: string };
export type WriteResult<T> = { kind: "ok"; hash: string; data: T } | { kind: "rejected"; hash: string; reason: string } | { kind: "failed"; hash: string | null; error: string };
