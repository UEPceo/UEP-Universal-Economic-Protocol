//! Public UEP-24 state model.
//!
//! UEP-24 models an atomic transition of three state leaves:
//! sender, recipient and treasury.
//!
//! Conservation:
//! sender_old + recipient_old + treasury_old
//! = sender_new + recipient_new + treasury_new
//!
//! with:
//! sender_new = sender_old - amount - fee
//! recipient_new = recipient_old + amount
//! treasury_new = treasury_old + fee

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AtomicBalances {
    pub sender_old: u64,
    pub recipient_old: u64,
    pub treasury_old: u64,
    pub amount: u64,
}

impl AtomicBalances {
    pub fn fee(&self) -> u64 {
        self.amount / 1_000
    }

    pub fn sender_new(&self) -> Option<u64> {
        self.sender_old.checked_sub(self.amount + self.fee())
    }

    pub fn recipient_new(&self) -> Option<u64> {
        self.recipient_old.checked_add(self.amount)
    }

    pub fn treasury_new(&self) -> Option<u64> {
        self.treasury_old.checked_add(self.fee())
    }

    pub fn is_conserving(&self) -> bool {
        let Some(s) = self.sender_new() else { return false };
        let Some(r) = self.recipient_new() else { return false };
        let Some(t) = self.treasury_new() else { return false };

        self.sender_old as u128 + self.recipient_old as u128 + self.treasury_old as u128
            == s as u128 + r as u128 + t as u128
    }
}
