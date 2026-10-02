use crate::{BPS_DENOM, FEE_BPS};

/// Minimum protocol fee for any positive amount (same as the public core).
pub const MIN_PROTOCOL_FEE: u64 = 1;

/// Protocol fee policy, identical to the public core and the UEP-26 circuit:
/// fee = max(1, floor(amount * 10 / 10_000)) for amount > 0, and 0 for amount = 0.
/// Small transfers cannot round down to a zero fee.
pub fn creator_fee(amount: u64) -> u64 {
    if amount == 0 {
        return 0;
    }
    let proportional = ((amount as u128 * FEE_BPS as u128) / BPS_DENOM as u128) as u64;
    proportional.max(MIN_PROTOCOL_FEE)
}

pub fn exact_fee_equation(amount: u64, fee: u64) -> bool {
    fee == creator_fee(amount)
}
