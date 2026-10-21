// Offline stand-in for WeChat's native viewport chrome; never shipped in the app.
import fs from 'node:fs';
import path from 'node:path';

export function nativeTabPreview(config, theme, mini, selected, hidden) {
  if (selected < 0) return { markup: '', css: '' };
  const value = (item, mode) => typeof item === 'string' && item.startsWith('@') ? theme?.[mode]?.[item.slice(1)] : item;
  const colors = mode => `.preview-native-tabbar{background:${value(config.backgroundColor, mode)};color:${value(config.color, mode)};border-top-color:${value(config.borderStyle, mode) === 'white' ? '#d8d8d8' : '#333'}}.preview-native-tabbar .is-selected{color:${value(config.selectedColor, mode)}}`;
  const markup = `<nav class="preview-native-tabbar" aria-label="原生底栏离线示意" ${hidden ? 'hidden' : ''}>${config.list.map((tab, index) => {
    const icon = fs.readFileSync(path.join(mini, index === selected ? tab.selectedIconPath : tab.iconPath)).toString('base64');
    return `<span class="preview-native-tab-item${index === selected ? ' is-selected' : ''}"><img src="data:image/png;base64,${icon}" alt=""><span class="preview-native-tab-label">${tab.text}</span></span>`;
  }).join('')}</nav>`;
  const css = `:root{--preview-native-safe:0px;--preview-native-height:50px}body:has(.preview-native-tabbar:not([hidden])){padding-bottom:calc(var(--preview-native-height) + var(--preview-native-safe))}.preview-native-tabbar{position:fixed;z-index:100;bottom:0;left:0;right:0;display:flex;box-sizing:border-box;height:calc(var(--preview-native-height) + var(--preview-native-safe));padding-bottom:var(--preview-native-safe);border-top:1px solid;box-shadow:none;backdrop-filter:none}.preview-native-tabbar[hidden]{display:none!important}.preview-native-tab-item{box-sizing:border-box;flex:1;min-width:0;height:var(--preview-native-height);display:flex;align-items:center;justify-content:center;flex-direction:column;font:10px/1.2 sans-serif}.preview-native-tab-item img{width:24px;height:24px;margin-bottom:2px}.preview-native-tab-label{white-space:nowrap}${colors('light')}@media(prefers-color-scheme:dark){${colors('dark')}}`;
  return { markup, css };
}
