//! UEP-28.11 — DEV vs TESTNET isolation for Groth16 artifacts.
//!
//! Test keys MUST never be accepted under a non-dev network profile.
//! This is protocol-level hygiene, not a ceremony.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NetworkProfile {
    /// Local development; test keys allowed.
    Dev,
    /// Experimental shared testnet; still test keys until ceremony — but tagged.
    Testnet,
    /// Local isolated lab (Poseidon Ledger Lab).
    Local,
}

impl NetworkProfile {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s.trim().to_ascii_lowercase().as_str() {
            "dev" | "development" => Ok(Self::Dev),
            "testnet" => Ok(Self::Testnet),
            "local" | "lab" => Ok(Self::Local),
            other => Err(format!("unknown network_profile: {other}")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dev => "dev",
            Self::Testnet => "testnet",
            Self::Local => "local",
        }
    }

    /// Test/setup keys are only valid for Dev and Local.
    pub fn allows_test_keys(self) -> bool {
        matches!(self, Self::Dev | Self::Local)
    }
}

/// Genesis descriptor for a network profile (not a blockchain genesis block).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkGenesis {
    pub profile: NetworkProfile,
    pub network_id: String,
    pub domain_id: String,
    /// Human label; not consensus-critical alone.
    pub label: String,
    /// When true, Groth16 must use ceremony VK (not implemented yet).
    pub require_ceremony_vk: bool,
}

impl NetworkGenesis {
    pub fn dev() -> Self {
        Self {
            profile: NetworkProfile::Dev,
            network_id: "uep-dev-1".into(),
            domain_id: "EARTH".into(),
            label: "UEP development (test keys only)".into(),
            require_ceremony_vk: false,
        }
    }

    pub fn local_lab() -> Self {
        Self {
            profile: NetworkProfile::Local,
            network_id: "uep-poseidon-lab-1".into(),
            domain_id: "LAB".into(),
            label: "Poseidon Ledger Lab".into(),
            require_ceremony_vk: false,
        }
    }

    pub fn testnet() -> Self {
        Self {
            profile: NetworkProfile::Testnet,
            network_id: "uep-testnet-1".into(),
            domain_id: "EARTH".into(),
            label: "UEP testnet (still DEV keys until ceremony — tagged)".into(),
            // Still false until ceremony exists; nodes must still reject cross-profile VK mixups.
            require_ceremony_vk: false,
        }
    }
}

/// Guard: refuse to treat a proof as testnet-secure if it was produced under DEV profile.
pub fn assert_profile_compatible(request_profile: &str, artifact_tag: &str) -> Result<(), String> {
    let p = NetworkProfile::parse(request_profile)?;
    if artifact_tag.contains("DEV") || artifact_tag.contains("test-keys") {
        if !p.allows_test_keys() {
            return Err(format!(
                "artifact tagged test-keys/DEV cannot be used under profile {}",
                p.as_str()
            ));
        }
    }
    Ok(())
}
