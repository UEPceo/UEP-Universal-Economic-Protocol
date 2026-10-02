use crate::fee::creator_fee;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct State {
    pub sender: u64,
    pub recipient: u64,
    pub treasury: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Transition {
    pub old: State,
    pub amount: u64,
    pub new: State,
    pub fee: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransitionError {
    InsufficientSenderBalance,
    RecipientOverflow,
    TreasuryOverflow,
    ConservationFailure,
}

pub fn transition(old: State, amount: u64) -> Result<Transition, TransitionError> {
    let fee = creator_fee(amount);
    let required = amount.checked_add(fee)
        .ok_or(TransitionError::InsufficientSenderBalance)?;

    let sender = old.sender.checked_sub(required)
        .ok_or(TransitionError::InsufficientSenderBalance)?;
    let recipient = old.recipient.checked_add(amount)
        .ok_or(TransitionError::RecipientOverflow)?;
    let treasury = old.treasury.checked_add(fee)
        .ok_or(TransitionError::TreasuryOverflow)?;

    let new = State { sender, recipient, treasury };

    let old_total = old.sender as u128 + old.recipient as u128 + old.treasury as u128;
    let new_total = new.sender as u128 + new.recipient as u128 + new.treasury as u128;

    if old_total != new_total {
        return Err(TransitionError::ConservationFailure);
    }

    Ok(Transition { old, amount, new, fee })
}
