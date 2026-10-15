// Payment, redemption and account-record tests intentionally isolate reminder
// authorization. Full queue/panel behavior runs in miniprogram-runtime tests.
// Do not load these WeChat-dependent modules through Node's host require.
export function isolatedAccountUi(name) {
  if (name.endsWith('/reminder-panel')) return { reminderPanelMethods: {
    observeAuthorization() {}, applyAuthorizationState() {}, resumeAuthorizationSync() {}, disposeAuthorizationPanel() {},
    syncAuthorizationOverlay() {}, hideAuthorizationOverlay() {}, isAuthorizationAccountCurrent: () => true,
  } };
  if (name.endsWith('/reminder-credits')) return {
    getAuthorizationState: () => ({ pendingCount: 0, acceptedByTemplate: {}, nativeBusy: false, syncing: false, storageBlocked: false, error: null }),
    topUpReminderCredit: () => false,
  };
  if (name.endsWith('/journey-context')) return { peekTestReturn: () => null, consumeTestReturnUrl: () => null };
  return null;
}
