// Selected native button rules verified read-only in the installed WeChat
// Developer Tools cache, WeappVendor/3.17.3.wxvpkg -> /WAWebview.js.
// Entry SHA-256: 51c8013a237fec0a6eed42b09da7b28bc6256e7ea8b843eba7dfc7ceb43839ba
// Only wx-button is mapped to HTML button; :where adds no selector specificity.
// This models the relevant cascade, not the complete native renderer or theme.
export const stockNativeButtonProfile = 'WeChat base library 3.17.3 selected button defaults: 184px non-mini width, auto inline margins, base typography/padding and explicit type colors; verified in local WAWebview.js; Chromium approximation only';
export const stockNativeButtonCss = `
:where(.follow-page) button{border-radius:4px;font-size:17px;font-weight:700;line-height:1.41176471;padding:8px 24px;}
:where(.follow-page) button:not([size=mini]){margin-left:auto;margin-right:auto;width:184px;}
:where(.follow-page) button:after{display:none;}
:where(.follow-page) button[type=primary]{background-color:#07c160;}
:where(.follow-page) button[type=default]{background-color:#f2f2f2;color:#06ae56;}
:where(.follow-page) button[type=warn]{background-color:#f2f2f2;color:#fa5151;}
:where(.follow-page) button[size=mini]{font-size:16px;line-height:2;padding:0 .75em;width:auto;}
`;
