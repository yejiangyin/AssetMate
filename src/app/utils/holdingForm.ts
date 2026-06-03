import type { HoldingInput } from "../context/AppContext";

export function canSaveHoldingForm(form: HoldingInput) {
  return Boolean(
    form.symbol.trim()
      && form.name.trim()
      && form.assetType
      && form.currency
      && form.quantity > 0
      && form.costPrice > 0
      && form.currentPrice >= 0
  );
}
