// Keyboard language follows the TypeGG quote: forwards each tab's quote
// language to the kb-lang native host (G835LX). Elsewhere the host is
// missing and sendNativeMessage just rejects.
let activeTab = null, sent, chain = Promise.resolve();

function setKbLang(lang) {
  const arg = lang || "restore";
  if (arg === sent) return;
  sent = arg;
  chain = chain.then(() => chrome.runtime.sendNativeMessage("io.typegg.kblang", { lang: arg })).catch(() => {});
}

chrome.runtime.onMessage.addListener((m, sender) => {
  if (!m || !("kbLang" in m)) return;
  const tab = sender.tab?.id;
  if (m.kbLang) { activeTab = tab; setKbLang(m.kbLang); }
  // A late "left" from a tab we already switched away from must not undo the new tab's language.
  else if (activeTab == null || activeTab === tab) { activeTab = null; setKbLang(null); }
});

chrome.tabs.onRemoved.addListener(id => { if (id === activeTab) { activeTab = null; setKbLang(null); } });
