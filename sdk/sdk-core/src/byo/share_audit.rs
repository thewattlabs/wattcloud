// Audit-log payload schema for OS share-sheet events.
//
// Records that an outbound `navigator.share` or an inbound Web Share Target
// event occurred. Stored as JSON inside an `INSERT` row of the `share_audit`
// table via the existing vault journal (`vault_journal::serialize_entry`).
// The table name lives in `vault_journal::ALLOWED_JOURNAL_TABLES`.
//
// Outbound entries carry no recipient identity: the Web Share API does not
// disclose which app the user picked. `counterparty_hint` is `None` for
// outbound and may carry the share-target `url` form field for inbound.

use crate::error::SdkError;
use serde::{Deserialize, Serialize};

/// Vault-journal table name for share-audit entries. Must match the entry in
/// `vault_journal::ALLOWED_JOURNAL_TABLES` — the journal codec rejects rows
/// targeting any other table.
pub const SHARE_AUDIT_TABLE: &str = "share_audit";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShareDirection {
    Outbound,
    Inbound,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShareAuditPayload {
    pub direction: ShareDirection,
    pub file_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub counterparty_hint: Option<String>,
    pub ts: u64,
}

/// Build the JSON bytes for a share-audit journal entry.
///
/// The returned bytes are passed unchanged as the `plaintext_data` argument
/// to `vault_journal::serialize_entry` against the [`SHARE_AUDIT_TABLE`].
pub fn build_share_audit_payload(
    direction: ShareDirection,
    file_ref: &str,
    counterparty_hint: Option<&str>,
    ts_ms: u64,
) -> Result<Vec<u8>, SdkError> {
    let payload = ShareAuditPayload {
        direction,
        file_ref: file_ref.to_string(),
        counterparty_hint: counterparty_hint.map(|s| s.to_string()),
        ts: ts_ms,
    };
    serde_json::to_vec(&payload).map_err(|e| SdkError::Api(format!("share_audit encode: {e}")))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn outbound_payload_shape() {
        let bytes =
            build_share_audit_payload(ShareDirection::Outbound, "file_42", None, 1_700_000_000_000)
                .unwrap();
        let decoded: ShareAuditPayload = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(decoded.direction, ShareDirection::Outbound);
        assert_eq!(decoded.file_ref, "file_42");
        assert!(decoded.counterparty_hint.is_none());
        assert_eq!(decoded.ts, 1_700_000_000_000);
    }

    #[test]
    fn outbound_omits_counterparty_hint_field() {
        let bytes = build_share_audit_payload(ShareDirection::Outbound, "x", None, 0).unwrap();
        let s = std::str::from_utf8(&bytes).unwrap();
        assert!(
            !s.contains("counterparty_hint"),
            "outbound JSON must omit counterparty_hint when None: {s}"
        );
    }

    #[test]
    fn inbound_payload_includes_counterparty_hint() {
        let bytes = build_share_audit_payload(
            ShareDirection::Inbound,
            "file_99",
            Some("https://example.com/x"),
            1_700_000_000_001,
        )
        .unwrap();
        let decoded: ShareAuditPayload = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(decoded.direction, ShareDirection::Inbound);
        assert_eq!(
            decoded.counterparty_hint.as_deref(),
            Some("https://example.com/x")
        );
    }

    #[test]
    fn share_audit_table_is_in_journal_allowlist() {
        use crate::byo::vault_journal::ALLOWED_JOURNAL_TABLES;
        assert!(
            ALLOWED_JOURNAL_TABLES.contains(&SHARE_AUDIT_TABLE),
            "SHARE_AUDIT_TABLE must appear in ALLOWED_JOURNAL_TABLES"
        );
    }

    #[test]
    fn direction_serializes_lowercase() {
        let bytes = build_share_audit_payload(ShareDirection::Inbound, "x", None, 0).unwrap();
        let s = std::str::from_utf8(&bytes).unwrap();
        assert!(s.contains(r#""direction":"inbound""#), "got: {s}");
    }
}
