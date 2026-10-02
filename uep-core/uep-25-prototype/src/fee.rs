use crate::{BPS_DENOM, FEE_BPS};

/// Protocol fee policy.
///
/// Current integer-unit policy:
/// fee = floor(amount * 10 / 10_000) = floor(amount / 1_000).
///
/// The floor policy is explicit. Amounts below 1,000 units therefore pay zero.
/// Before a production network, the denomination/dust policy must be frozen.
pub fn creator_fee(amount: u64) -> u64 {
    ((amount as u128 * FEE_BPS as u128) / BPS_DENOM as u128) as u64
}

pub fn exact_fee_equation(amount: u64, fee: u64) -> bool {
    fee as u128 * BPS_DENOM as u128 == amount as u128 * FEE_BPS as u128
        || fee == creator_fee(amount)
}
