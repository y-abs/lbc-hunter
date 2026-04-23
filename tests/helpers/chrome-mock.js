// ─────────────────────────────────────────────
//  Minimal in-memory chrome.* mock for MV3 tests.
//
//  Coverage: alarms, storage.{local,session}, tabs, runtime (messaging +
//  lifecycle), notifications, scripting, offscreen, permissions.
//  Each sub-namespace is introspectable (spies via vi.fn-style recorders)
//  and fully reset between tests via `resetChromeMock()`.
//
//  We deliberately DO NOT use `vi.fn()` here so this helper loads without
//  a test context (e.g. from a node REPL for debugging). Where a test
//  needs a spy, it can wrap via `vi.spyOn(chrome.x, 'y')`.
// ─────────────────────────────────────────────

const listeners = {
  alarm: [],
  message: [],
  notifClick: [],
  notifButton: [],
  notifClose: [],
  installed: [],
  startup: [],
  tabUpdated: [],
  tabRemoved: [],
};

function makeStorageArea() {
  let data = {};
  return {
    get(keys) {
      if (keys == null) return Promise.resolve({ ...data });
      if (typeof keys === "string") {
        return Promise.resolve(keys in data ? { [keys]: data[keys] } : {});
      }
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (k in data) out[k] = data[k];
        return Promise.resolve(out);
      }
      // object form: defaults
      const out = {};
      for (const [k, def] of Object.entries(keys)) out[k] = k in data ? data[k] : def;
      return Promise.resolve(out);
    },
    set(items) {
      Object.assign(data, items);
      return Promise.resolve();
    },
    remove(keys) {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) delete data[k];
      return Promise.resolve();
    },
    clear() {
      data = {};
      return Promise.resolve();
    },
    __peek() {
      return data;
    },
    __reset() {
      data = {};
    },
  };
}

const storageLocal = makeStorageArea();
const storageSession = makeStorageArea();

const alarms = {
  _list: new Map(),
  create(name, info) {
    this._list.set(name, { name, ...info });
    return Promise.resolve();
  },
  get(name) {
    return Promise.resolve(this._list.get(name) || null);
  },
  getAll() {
    return Promise.resolve([...this._list.values()]);
  },
  clear(name) {
    return Promise.resolve(this._list.delete(name));
  },
  clearAll() {
    this._list.clear();
    return Promise.resolve(true);
  },
  onAlarm: {
    addListener(fn) {
      listeners.alarm.push(fn);
    },
    removeListener(fn) {
      const i = listeners.alarm.indexOf(fn);
      if (i >= 0) listeners.alarm.splice(i, 1);
    },
  },
  __fire(name) {
    const alarm = this._list.get(name) || { name };
    for (const fn of listeners.alarm) fn(alarm);
  },
  __reset() {
    this._list.clear();
  },
};

const notifications = {
  _list: new Map(),
  create(id, opts) {
    const notifId = typeof id === "string" ? id : String(Date.now());
    this._list.set(notifId, { id: notifId, ...opts });
    return Promise.resolve(notifId);
  },
  clear(id) {
    this._list.delete(id);
    return Promise.resolve(true);
  },
  getAll() {
    return Promise.resolve(Object.fromEntries(this._list));
  },
  onClicked: {
    addListener(fn) {
      listeners.notifClick.push(fn);
    },
    removeListener(fn) {
      const i = listeners.notifClick.indexOf(fn);
      if (i >= 0) listeners.notifClick.splice(i, 1);
    },
  },
  onButtonClicked: {
    addListener(fn) {
      listeners.notifButton.push(fn);
    },
    removeListener(fn) {
      const i = listeners.notifButton.indexOf(fn);
      if (i >= 0) listeners.notifButton.splice(i, 1);
    },
  },
  onClosed: {
    addListener(fn) {
      listeners.notifClose.push(fn);
    },
    removeListener(fn) {
      const i = listeners.notifClose.indexOf(fn);
      if (i >= 0) listeners.notifClose.splice(i, 1);
    },
  },
  __fireClick(id) {
    for (const fn of listeners.notifClick) fn(id);
  },
  __fireButton(id, index) {
    for (const fn of listeners.notifButton) fn(id, index);
  },
  __fireClosed(id, byUser) {
    for (const fn of listeners.notifClose) fn(id, byUser);
  },
  __reset() {
    this._list.clear();
  },
};

const tabs = {
  _list: new Map(),
  _nextId: 1,
  query(info) {
    const all = [...this._list.values()];
    return Promise.resolve(
      all.filter((t) => {
        if (info?.url) {
          const pats = Array.isArray(info.url) ? info.url : [info.url];
          return pats.some((p) => {
            const re = new RegExp("^" + p.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
            return re.test(t.url);
          });
        }
        if (info?.active != null) return t.active === info.active;
        return true;
      }),
    );
  },
  get(id) {
    const t = this._list.get(id);
    if (!t) return Promise.reject(new Error("No tab with id: " + id));
    return Promise.resolve(t);
  },
  create(props) {
    const id = this._nextId++;
    const tab = { id, url: props.url, active: props.active ?? true, status: "complete", ...props };
    this._list.set(id, tab);
    return Promise.resolve(tab);
  },
  update(id, props) {
    const t = this._list.get(id);
    if (!t) return Promise.reject(new Error("no tab"));
    Object.assign(t, props);
    return Promise.resolve(t);
  },
  remove(id) {
    this._list.delete(id);
    return Promise.resolve();
  },
  sendMessage(_id, _msg) {
    return Promise.resolve(undefined);
  },
  onUpdated: {
    addListener(fn) {
      listeners.tabUpdated.push(fn);
    },
    removeListener(fn) {
      const i = listeners.tabUpdated.indexOf(fn);
      if (i >= 0) listeners.tabUpdated.splice(i, 1);
    },
  },
  onRemoved: {
    addListener(fn) {
      listeners.tabRemoved.push(fn);
    },
    removeListener(fn) {
      const i = listeners.tabRemoved.indexOf(fn);
      if (i >= 0) listeners.tabRemoved.splice(i, 1);
    },
  },
  __fireUpdated(tabId, changeInfo, tab) {
    for (const fn of listeners.tabUpdated) fn(tabId, changeInfo, tab);
  },
  __fireRemoved(tabId) {
    for (const fn of listeners.tabRemoved) fn(tabId, {});
  },
  __reset() {
    this._list.clear();
    this._nextId = 1;
  },
};

// Runtime.sendMessage is configurable per-test via __setHandler
let _messageHandler = async () => undefined;

const runtime = {
  id: "test-extension-id",
  lastError: null,
  sendMessage(msg) {
    return Promise.resolve().then(() => _messageHandler(msg));
  },
  getURL(path) {
    return "chrome-extension://test/" + path.replace(/^\//, "");
  },
  onMessage: {
    addListener(fn) {
      listeners.message.push(fn);
    },
    removeListener(fn) {
      const i = listeners.message.indexOf(fn);
      if (i >= 0) listeners.message.splice(i, 1);
    },
  },
  onInstalled: {
    addListener(fn) {
      listeners.installed.push(fn);
    },
    removeListener(fn) {
      const i = listeners.installed.indexOf(fn);
      if (i >= 0) listeners.installed.splice(i, 1);
    },
  },
  onStartup: {
    addListener(fn) {
      listeners.startup.push(fn);
    },
    removeListener(fn) {
      const i = listeners.startup.indexOf(fn);
      if (i >= 0) listeners.startup.splice(i, 1);
    },
  },
  __setHandler(fn) {
    _messageHandler = fn;
  },
  __fireInstalled(details) {
    for (const fn of listeners.installed) fn(details);
  },
  __fireStartup() {
    for (const fn of listeners.startup) fn();
  },
  /**
   * Dispatch a message to the onMessage.addListener chain the same way
   * Chrome would. Returns a Promise resolving to the first response.
   */
  __dispatch(msg, sender = {}) {
    return new Promise((resolve) => {
      let resolved = false;
      const sendResponse = (r) => {
        if (!resolved) {
          resolved = true;
          resolve(r);
        }
      };
      for (const fn of listeners.message) {
        const ret = fn(msg, sender, sendResponse);
        // Chrome requires `return true` for async responses.
        if (ret === true) return; // async — wait for sendResponse
        if (ret !== undefined && typeof ret.then === "function") {
          ret.then(sendResponse, () => sendResponse(undefined));
          return;
        }
      }
      // No async handler claimed it.
      if (!resolved) resolve(undefined);
    });
  },
  __reset() {
    _messageHandler = async () => undefined;
  },
};

const scripting = {
  _calls: [],
  executeScript(opts) {
    this._calls.push(opts);
    return Promise.resolve([{ result: undefined }]);
  },
  __reset() {
    this._calls.length = 0;
  },
};

const offscreen = {
  hasDocument() {
    return Promise.resolve(false);
  },
  createDocument() {
    return Promise.resolve();
  },
  closeDocument() {
    return Promise.resolve();
  },
};

const permissions = {
  contains() {
    return Promise.resolve(true);
  },
  request() {
    return Promise.resolve(true);
  },
};

const action = {
  setBadgeText() {
    return Promise.resolve();
  },
  setBadgeBackgroundColor() {
    return Promise.resolve();
  },
};

export function installChromeMock() {
  globalThis.chrome = {
    alarms,
    tabs,
    runtime,
    notifications,
    scripting,
    offscreen,
    permissions,
    action,
    storage: { local: storageLocal, session: storageSession },
  };
}

export function resetChromeMock() {
  alarms.__reset();
  tabs.__reset();
  runtime.__reset();
  notifications.__reset();
  scripting.__reset();
  storageLocal.__reset();
  storageSession.__reset();
  for (const key of Object.keys(listeners)) listeners[key].length = 0;
}

export { listeners as __listeners };
