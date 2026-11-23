import { runtime } from './miniprogram-runtime.mjs';

const localeModules = new WeakMap();

// Payment, redemption and account-record tests intentionally isolate reminder
// authorization. Full queue/panel behavior runs in miniprogram-runtime tests.
// Do not load these WeChat-dependent modules through Node's host require.
export function isolatedAccountUi(name, wx) {
  if (name.endsWith('/language')) {
    if (!localeModules.has(wx)) {
      const local = runtime();
      Object.assign(local.wx, wx);
      localeModules.set(wx, local.load('utils/language.js'));
    }
    return localeModules.get(wx);
  }
  if (name.endsWith('/reminder-panel')) return { reminderPanelMethods: {
    observeAuthorization() {}, applyAuthorizationState() {}, resumeAuthorizationSync() {}, disposeAuthorizationPanel() {},
    syncAuthorizationOverlay() {}, hideAuthorizationOverlay() {}, isAuthorizationAccountCurrent: () => true,
  } };
  if (name.endsWith('/reminder-credits')) return {
    getAuthorizationState: () => ({ pendingCount: 0, acceptedByTemplate: {}, nativeBusy: false, syncing: false, storageBlocked: false, error: null }),
    topUpReminderCredit: () => false,
    buildConsentReport: () => ({ mainSwitchOff: false, items: [], blocked: [], open: [], anyBlocked: false, allBlocked: false, restockBlocked: false, known: false }),
    openSubscribeSettings: () => {},
    consentLockState: () => null,
    refreshConsentSetting: () => {},
    refreshConsentSettingAsync: () => Promise.resolve(null),
    showConsentSettingsGuide: () => {},
    getConsentSetting: () => null,
  };
  if (name.endsWith('/journey-context')) return { peekTestReturn: () => null, consumeTestReturnUrl: () => null };
  return null;
}
