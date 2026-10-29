/**
 * Browser half of dsh-study-ask (学习提问).
 *
 * Select text in the main conversation, click “提问”, and a dedicated question
 * conversation opens in the native right sidebar, side by side with the main
 * study conversation. The question conversation is a real DSH session, but it
 * is owned by this plugin: it is created once per main session, remembered in
 * localStorage, and hidden from the left session list so it never competes
 * with the conversations you actually browse.
 *
 * Mechanism (same shape as the shipped subagent sidebar chat):
 *
 *   selection in the main transcript
 *     -> floating “提问” button
 *     -> ensureSideSession(mainSessionId)  (create once, remember, hide row)
 *     -> ctx.sidebarRight.openResource('dsh-resource://studyask/session/<id>')
 *     -> our `studyask` resource provider (sessions.retain)
 *     -> `sidebar.right.pane.tab` seat rendering the shared conversation
 *     -> the quoted excerpt is pushed into that session's composer draft
 *
 * The question session keeps its own history, so follow-up questions about the
 * same topic stay in one thread instead of spawning a new `❓` session each
 * time.
 *
 * @module dsh-study-ask/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-study-ask',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    /** Client root context, captured by apply() so handlers can resolve services lazily. */
    var pluginCtx = null

    /** Cordis plugin name / client module id: must equal the package name. */
    var NAME = 'dsh-study-ask'
    /** Locale dictionary namespace owned by this plugin. */
    var NS = 'studyAsk'
    /** Right-sidebar tab kind registered by this plugin. */
    var KIND = 'studyask'
    /** Identity shared by the tab type and the body/title slot cells. */
    var TAB_ID = 'dsh-study-ask'
    /** Resource protocol (the `dsh-resource://` URL host). */
    var PROTOCOL = 'studyask'
    /** Canonical address prefix for an embedded question conversation. */
    var ADDRESS_PREFIX = 'dsh-resource://studyask/session/'
    /** Session-scoped slot carrying the conversation inside the tab body. */
    var SLOT_CONVERSATION = 'studyask.conversation'
    /** Ref source tag; the main view uses `mainView`, so keep ours distinct. */
    var RESOURCE_SOURCE = 'studyAsk'
    /** localStorage key: main session id -> question session id. */
    var MAP_KEY = 'dsh-study-ask:map.v1'

    /** Simplified Chinese dictionary (key-set source of truth). */
    var zh = {
      'popover.ask': '提问',
      'popover.hint': '就选中的内容在右侧提问',
      'entry.ask': '提问对话',
      'entry.hint': '打开这一段学习对话的提问对话（选中的文字会自动带过去）',
      'tab.title': '提问对话',
      'duplicate.title': '该会话已在主区打开',
      'duplicate.body': '主区和右侧栏不能同时编辑同一个会话。把主区切到别的会话，或关闭此标签。',
      'open.failed.title': '无法打开提问对话',
      'open.failed.body': '它可能已被归档或删除。关闭此标签后重新点「提问对话」即可重建。',
      'toast.opened': '已在右侧打开提问对话',
      'toast.created': '已新建提问对话',
      'toast.noMain': '当前没有打开的对话',
      'toast.noSelection': '没有选中内容',
      'toast.createFailed': '创建提问对话失败',
      'toast.openFailed': '无法在右侧打开提问对话',
      'toast.quoteMissed': '提问对话已打开，但引文没有填进输入框'
    }
    /** English dictionary, key-identical to the Chinese source of truth. */
    var en = {
      'popover.ask': 'Ask',
      'popover.hint': 'Ask about the selected text in the sidebar',
      'entry.ask': 'Question chat',
      'entry.hint': 'Open this conversation’s question chat (selected text comes along)',
      'tab.title': 'Question chat',
      'duplicate.title': 'This session is open in the main view',
      'duplicate.body': 'The main view and the sidebar cannot edit the same session. Switch the main view, or close this tab.',
      'open.failed.title': 'This question chat could not be opened',
      'open.failed.body': 'It may have been archived or deleted. Close this tab and use “Question chat” to rebuild it.',
      'toast.opened': 'Question chat opened in the sidebar',
      'toast.created': 'Question chat created',
      'toast.noMain': 'There is no open conversation',
      'toast.noSelection': 'Nothing is selected',
      'toast.createFailed': 'Could not create the question chat',
      'toast.openFailed': 'Could not open the question chat in the sidebar',
      'toast.quoteMissed': 'Question chat opened, but the quote did not reach the composer'
    }

    //#region address

    /**
     * Canonical resource address for one question conversation.
     *
     * @param sessionId - the Session to address.
     * @returns the `dsh-resource://studyask/session/<id>` address.
     */
    function addressOf(sessionId) {
      return ADDRESS_PREFIX + encodeURIComponent(String(sessionId))
    }

    /**
     * Parse one canonical question-conversation resource address.
     *
     * @param value - possible question-chat resource address.
     * @returns the encoded Session id, or undefined for another or malformed resource.
     */
    function parseAddress(value) {
      if (typeof value !== 'string' || value === '') return undefined
      var url
      try {
        url = new URL(value)
      } catch (_invalidUrl) {
        return undefined
      }
      if (url.protocol !== 'dsh-resource:' || url.hostname !== PROTOCOL) return undefined
      var parts = url.pathname.split('/').filter(Boolean)
      if (parts.length !== 2 || parts[0] !== 'session') return undefined
      var sessionId
      try {
        sessionId = decodeURIComponent(parts[1])
      } catch (_invalidEncoding) {
        return undefined
      }
      return sessionId === '' ? undefined : sessionId
    }

    /**
     * Settle when the resource stream's signal aborts.
     *
     * @param signal - the resource record's lifetime signal.
     * @returns a promise resolved on abort (or already resolved).
     */
    function waitAbort(signal) {
      if (signal.aborted) return Promise.resolve()
      return new Promise(function (resolve) {
        signal.addEventListener('abort', resolve, { once: true })
      })
    }
    //#endregion

    //#region store: main session -> owned question session

    /**
     * The Desktop shell serves the UI on `--port 0` (a fresh port every launch),
     * so `localStorage` — which is keyed by origin, and origin includes the port
     * — is wiped on every restart. Two durable devices replace it:
     *
     *  1. a deterministic session id: `session-<uuidv5(mainId)>` requested when
     *     the question session is created, so the mapping can be recomputed;
     *  2. a cookie, which is scoped by host (not port) and therefore survives
     *     the port change when the Host declines the requested id.
     */
    var COOKIE_NAME = 'dsh_study_ask_map'
    /** In-memory set of the question session ids this plugin owns. */
    var ownedIds = {}
    /** UUIDv5 namespace (RFC 4122 DNS namespace bytes). */
    var UUID_NAMESPACE = [0x6b, 0xa7, 0xb8, 0x10, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8]

    /** Read one cookie value (URL-decoded), or null. */
    function readCookie(name) {
      if (typeof document === 'undefined') return null
      try {
        var parts = String(document.cookie || '').split(';')
        for (var i = 0; i < parts.length; i += 1) {
          var part = parts[i].trim()
          var eq = part.indexOf('=')
          if (eq < 0) continue
          if (part.slice(0, eq) !== name) continue
          return decodeURIComponent(part.slice(eq + 1))
        }
      } catch (_cookieError) {
        // Cookie access can be blocked; the deterministic id still works.
      }
      return null
    }

    /** Write one long-lived first-party cookie. */
    function writeCookie(name, value) {
      if (typeof document === 'undefined') return
      try {
        document.cookie =
          name + '=' + encodeURIComponent(value) + '; Path=/; Max-Age=31536000; SameSite=Lax'
      } catch (_cookieError) {
        // Ignore: the deterministic id remains the primary mechanism.
      }
    }

    /** Read the persisted main->question map (cookie first, then localStorage). */
    function loadMap() {
      if (typeof window === 'undefined') return {}
      var raw = readCookie(COOKIE_NAME)
      if (raw === null) {
        try {
          raw = window.localStorage.getItem(MAP_KEY)
        } catch (_mapError) {
          raw = null
        }
      }
      if (raw === null || raw === '') return {}
      try {
        var parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' ? parsed : {}
      } catch (_parseError) {
        return {}
      }
    }

    /** Persist the main->question map in both devices (best effort). */
    function saveMap(map) {
      if (typeof window === 'undefined') return
      var raw
      try {
        raw = JSON.stringify(map)
      } catch (_serializeError) {
        return
      }
      writeCookie(COOKIE_NAME, raw)
      try {
        window.localStorage.setItem(MAP_KEY, raw)
      } catch (_mapError) {
        // A full or blocked localStorage must not break the ask flow.
      }
    }

    /** Every question session id this plugin knows about. */
    function ownedSessionIds() {
      var map = loadMap()
      var out = []
      var seen = {}
      for (var key in map) {
        if (typeof map[key] === 'string' && map[key] !== '' && seen[map[key]] !== true) {
          seen[map[key]] = true
          out.push(map[key])
        }
      }
      for (var owned in ownedIds) {
        if (seen[owned] !== true) {
          seen[owned] = true
          out.push(owned)
        }
      }
      return out
    }

    /** SHA-1 over a byte array. */
    async function sha1Bytes(bytes) {
      var digest = await crypto.subtle.digest('SHA-1', bytes)
      return new Uint8Array(digest)
    }

    /** Format 16 bytes as a version-5 UUID string. */
    function uuidFromBytes(bytes) {
      var copy = new Uint8Array(bytes)
      copy[6] = (copy[6] & 0x0f) | 0x50
      copy[8] = (copy[8] & 0x3f) | 0x80
      var hex = ''
      for (var i = 0; i < 16; i += 1) hex += (copy[i] + 0x100).toString(16).slice(1)
      return (
        hex.slice(0, 8) +
        '-' +
        hex.slice(8, 12) +
        '-' +
        hex.slice(12, 16) +
        '-' +
        hex.slice(16, 20) +
        '-' +
        hex.slice(20)
      )
    }

    /**
     * The deterministic question-session id for one main session. Requesting it
     * on create makes the mapping recomputable after any restart, with no
     * storage at all.
     *
     * @param mainId - the main (study) session id.
     * @returns `session-<uuidv5>`, or undefined when WebCrypto is unavailable.
     */
    async function deterministicId(mainId) {
      if (typeof crypto === 'undefined' || crypto.subtle === undefined) return undefined
      try {
        var name = new TextEncoder().encode(String(mainId))
        var bytes = new Uint8Array(UUID_NAMESPACE.length + name.length)
        bytes.set(UUID_NAMESPACE, 0)
        bytes.set(name, UUID_NAMESPACE.length)
        var digest = await sha1Bytes(bytes)
        return 'session-' + uuidFromBytes(digest)
      } catch (_hashError) {
        return undefined
      }
    }

    /**
     * Recompute which sessions this plugin owns: for every known session id,
     * its deterministic question id either exists (we created it earlier) or
     * does not. This recovers the mapping without any persisted state.
     */
    async function rebuildOwned(ctx) {
      var rows = sessionRows(ctx)
      var ids = Object.keys(rows)
      var map = loadMap()
      var changed = false
      for (var i = 0; i < ids.length; i += 1) {
        var mainId = ids[i]
        var det = await deterministicId(mainId)
        if (det === undefined || rows[det] === undefined) continue
        if (ownedIds[det] !== true) {
          ownedIds[det] = true
          changed = true
        }
        if (map[mainId] !== det) {
          map[mainId] = det
          changed = true
        }
      }
      for (var key in map) {
        if (rows[map[key]] !== undefined) ownedIds[map[key]] = true
      }
      if (changed) saveMap(map)
      return changed
    }

    /** The session list rows the client currently knows about. */
    function sessionRows(ctx) {
      try {
        return ctx.sessions.list.getSnapshot().byId || {}
      } catch (_rowsError) {
        return {}
      }
    }

    /** Whether a session id still exists in the client's session list. */
    function sessionExists(ctx, sessionId) {
      return sessionRows(ctx)[sessionId] !== undefined
    }

    //#endregion

    //#region hide owned sessions from the left list

    var HIDDEN_CSS_ID = 'dsh-study-ask/hidden.css'

    /**
     * Keep a stylesheet that hides every owned question session from the left
     * session tree. The tree renders one row per session with
     * `data-row-key="session:<id>"`, so a static rule keeps hiding rows that
     * appear later (e.g. after the question session's first message).
     */
    function syncHiddenCss() {
      if (typeof document === 'undefined') return
      var rules = ''
      var ids = ownedSessionIds()
      for (var i = 0; i < ids.length; i += 1) {
        var id = ids[i]
        if (!/^[A-Za-z0-9._:-]+$/.test(id)) continue
        rules += '[data-row-key="session:' + id + '"]{display:none!important}'
      }
      var tag = document.getElementById(HIDDEN_CSS_ID)
      if (tag === null) {
        tag = document.createElement('style')
        tag.id = HIDDEN_CSS_ID
        tag.dataset.plugin = NAME
        ;(document.head || document.documentElement).appendChild(tag)
      }
      if (tag.textContent !== rules) tag.textContent = rules
    }
    //#endregion

    //#region resource provider

    /**
     * The `studyask` resource provider: retain one Session for as long as a
     * record holds the address, and hand the reference to the tab body.
     *
     * @param sessions - the client Sessions service.
     * @returns the provider to register with `ctx.resources`.
     */
    function questionResourceProvider(sessions) {
      return {
        protocol: PROTOCOL,
        async *open(resourceAddress, options) {
          var signal = options && options.signal !== undefined ? options.signal : new AbortController().signal
          var sessionId = parseAddress(resourceAddress)
          if (sessionId === undefined) throw new Error('dsh-study-ask: invalid resource address "' + resourceAddress + '"')
          if (signal.aborted) return
          var reference
          try {
            reference = sessions.retain(sessionId, { source: RESOURCE_SOURCE, signal: signal })
          } catch (error) {
            // A removed/archived session is a normal dead tab, not a bundle fault.
            yield { ok: false, error: error }
            return
          }
          try {
            yield { ok: true, value: { sessionId: sessionId, reference: reference } }
            await waitAbort(signal)
          } finally {
            reference.release()
          }
        }
      }
    }
    //#endregion

    //#region ask flow

    /** The main Session the conversation currently fills the main column with. */
    function mainSessionId(ctx) {
      try {
        var mounted = ctx.sidebarRight === undefined ? undefined : ctx.sidebarRight.mounted
        var onScreen = mounted === undefined ? undefined : mounted.getSnapshot()
        if (onScreen !== undefined) return onScreen
      } catch (_mountedError) {
        // Fall through to the retained-row scan.
      }
      try {
        var byId = ctx.sessions.list.getSnapshot().byId || {}
        for (var key in byId) {
          var row = byId[key]
          if (row !== undefined && row.retainedBy !== undefined && row.retainedBy.mainView > 0) return key
        }
      } catch (_mainError) {
        // Unknown until the session list hydrates.
      }
      return undefined
    }

    /** The workspace owning a session, or undefined when ungrouped. */
    function workspaceIdOf(ctx, sessionId) {
      try {
        var workspaces = typeof ctx.get === 'function' ? ctx.get('workspaces') : undefined
        var snapshot = workspaces === undefined ? undefined : workspaces.list.getSnapshot()
        var items = snapshot === undefined ? [] : snapshot.items || []
        for (var i = 0; i < items.length; i += 1) {
          var ids = items[i].sessionIds || []
          for (var j = 0; j < ids.length; j += 1) {
            if (ids[j] === sessionId) return items[i].workspaceId
          }
        }
      } catch (_workspaceError) {
        // Ungrouped sessions are still creatable from their cwd.
      }
      return undefined
    }

    /**
     * Resolve (or lazily create) the question conversation owned by one main
     * session. Creation is one-off: later asks reuse the same session, so the
     * question thread accumulates instead of spawning a new `❓` session.
     *
     * @param ctx - client root context.
     * @param mainId - the main (study) session the question belongs to.
     * @returns the question session id.
     */
    async function ensureQuestionSession(ctx, mainId) {
      var rows = sessionRows(ctx)
      // 1) The deterministic id: survives restarts with no storage at all.
      var det = await deterministicId(mainId)
      if (det !== undefined && rows[det] !== undefined) {
        ownedIds[det] = true
        return det
      }
      // 2) The persisted map (cookie, then same-origin localStorage).
      var map = loadMap()
      var existing = map[mainId]
      if (typeof existing === 'string' && existing !== '' && rows[existing] !== undefined) {
        ownedIds[existing] = true
        return existing
      }
      if (existing !== undefined) {
        delete map[mainId]
        saveMap(map)
        syncHiddenCss()
      }
      // 3) Create once, asking for the deterministic id so later lookups are free.
      var row = rows[mainId]
      var request = {}
      if (det !== undefined) request.sessionId = det
      var workspaceId = workspaceIdOf(ctx, mainId)
      if (workspaceId !== undefined) request.workspaceId = workspaceId
      else if (row !== undefined && typeof row.cwd === 'string' && row.cwd !== '') request.cwd = row.cwd
      var created = await ctx.sessions.create(request)
      ownedIds[created] = true
      map[mainId] = created
      saveMap(map)
      syncHiddenCss()
      try {
        var title = row !== undefined && typeof row.title === 'string' && row.title !== '' ? row.title : ''
        await ctx.sessions.rename(created, title === '' ? '提问对话' : '提问 · ' + title)
      } catch (_renameError) {
        // The tab title is ours anyway; the durable title is cosmetic.
      }
      return created
    }

    /**
     * Open one question conversation in the right sidebar (creating it first
     * when needed), then push the quoted excerpt into its composer draft.
     *
     * @param mainId - the main session the ask belongs to.
     * @param quote - selected excerpt, or null to just open the conversation.
     */
    async function openQuestionChat(mainId, quote) {
      var ctx = pluginCtx
      var t = ctx.locale.bind(NS)
      if (typeof mainId !== 'string' || mainId === '') {
        toast(t('toast.noMain'))
        return
      }
      var questionId
      try {
        questionId = await ensureQuestionSession(ctx, mainId)
      } catch (error) {
        console.error('dsh-study-ask: could not create the question session', error)
        toast(t('toast.createFailed'))
        return
      }
      try {
        ctx.sidebarRight.openResource(addressOf(questionId), { kind: KIND, preferNewPane: false })
      } catch (error) {
        console.error('dsh-study-ask: could not open the question chat', error)
        toast(t('toast.openFailed'))
        return
      }
      if (typeof quote === 'string' && quote.trim() !== '') {
        var filled = await prefillQuote(questionId, quote)
        toast(filled ? t('toast.opened') : t('toast.quoteMissed'))
      } else {
        toast(t('toast.opened'))
      }
    }

    /** Format one excerpt as a Markdown blockquote draft. */
    function quoteDraft(text) {
      var lines = String(text).replace(/\r\n/g, '\n').split('\n')
      var out = []
      for (var i = 0; i < lines.length; i += 1) out.push('> ' + lines[i])
      return out.join('\n') + '\n\n'
    }

    /**
     * Push the excerpt into one session's composer draft, appending to what the
     * user already typed. The tab has to mount first, so retry briefly.
     *
     * @param sessionId - the question session whose composer receives the quote.
     * @param text - the selected excerpt.
     * @returns whether the draft was written.
     */
    async function prefillQuote(sessionId, text) {
      var draftText = quoteDraft(text)
      for (var attempt = 0; attempt < 40; attempt += 1) {
        try {
          var conversation = typeof pluginCtx.get === 'function' ? pluginCtx.get('conversation') : undefined
          var input = conversation === undefined || conversation === null ? undefined : conversation.input
          if (input !== undefined && typeof input.shell === 'function') {
            var shell = input.shell(sessionId)
            var state = shell.state.getSnapshot()
            var draft = typeof state.draft === 'string' ? state.draft : ''
            var next = draft.trim() === '' ? draftText : draft.replace(/\s+$/, '') + '\n\n' + draftText
            shell.actions.setDraft(next)
            return true
          }
        } catch (_prefillError) {
          // The shell is not mounted yet; retry.
        }
        await new Promise(function (resolve) {
          setTimeout(resolve, 100)
        })
      }
      return false
    }
    //#endregion

    //#region selection popover

    var popoverElement = null
    var popoverText = ''
    var popoverFrame = 0

    /** Show a short-lived confirmation toast without depending on a UI framework. */
    function toast(message) {
      if (typeof document === 'undefined' || document.body === undefined || document.body === null) return
      var element = document.createElement('div')
      element.className = 'dsa-toast'
      element.textContent = message
      document.body.appendChild(element)
      setTimeout(function () {
        element.className = 'dsa-toast dsa-toast-out'
      }, 1500)
      setTimeout(function () {
        element.remove()
      }, 2000)
    }

    /** The lazily created floating “提问” button. */
    function ensurePopover() {
      if (popoverElement !== null) return popoverElement
      popoverElement = document.createElement('button')
      popoverElement.type = 'button'
      popoverElement.className = 'dsa-pop'
      popoverElement.setAttribute('data-dsa-popover', '')
      popoverElement.textContent = '提问'
      popoverElement.addEventListener('mousedown', function (event) {
        // Keep the selection alive while the button is pressed.
        event.preventDefault()
        event.stopPropagation()
      })
      popoverElement.addEventListener('click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        var text = popoverText
        hidePopover()
        var mainId = mainSessionId(pluginCtx)
        if (text.trim() === '') {
          toast(pluginCtx.locale.bind(NS)('toast.noSelection'))
          return
        }
        openQuestionChat(mainId, text)
      })
      document.body.appendChild(popoverElement)
      return popoverElement
    }

    /** Hide the floating button and forget the pending excerpt. */
    function hidePopover() {
      if (popoverElement !== null) popoverElement.removeAttribute('data-dsa-open')
      popoverText = ''
    }

    /** Place the floating button above one selection rectangle. */
    function showPopover(rect) {
      var element = ensurePopover()
      if (pluginCtx !== null && pluginCtx.locale !== undefined) {
        element.textContent = pluginCtx.locale.bind(NS)('popover.ask')
      }
      var width = 64
      var left = rect.left + rect.width / 2 - width / 2
      if (left < 8) left = 8
      if (left + width > window.innerWidth - 8) left = window.innerWidth - 8 - width
      var top = rect.top - 38
      if (top < 8) top = rect.bottom + 8
      element.style.left = Math.round(left) + 'px'
      element.style.top = Math.round(top) + 'px'
      element.setAttribute('data-dsa-open', '')
    }

    /** The TeX source of one KaTeX node, or ''. */
    function texOfKatex(node) {
      try {
        var annotation = node.querySelector('annotation[encoding="application/x-tex"]')
        if (annotation === null) annotation = node.querySelector('annotation')
        if (annotation === null) return ''
        return String(annotation.textContent || '').trim()
      } catch (_texError) {
        return ''
      }
    }

    /**
     * Build the excerpt from the DOM instead of `selection.toString()`: KaTeX
     * keeps a visually hidden MathML copy next to the visual HTML, so plain
     * selection text contains every formula twice and as scattered glyphs.
     * A formula contributes its TeX source as `$…$` instead.
     *
     * @param range - the selected range.
     * @returns the excerpt to quote.
     */
    function excerptOfRange(range) {
      var startElement =
        range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer
      var startKatex =
        startElement !== null && startElement !== undefined && typeof startElement.closest === 'function'
          ? startElement.closest('.katex')
          : null
      // A selection inside one formula quotes that whole formula as TeX.
      if (startKatex !== null && startKatex !== undefined && startKatex.contains(range.endContainer)) {
        var innerTex = texOfKatex(startKatex)
        if (innerTex !== '') return '$' + innerTex + '$'
      }
      var holder
      try {
        holder = document.createElement('div')
        holder.appendChild(range.cloneContents())
      } catch (_cloneError) {
        return String(window.getSelection() || '').trim()
      }
      var maths = holder.querySelectorAll('.katex')
      for (var i = 0; i < maths.length; i += 1) {
        var node = maths[i]
        if (node.parentNode === null) continue
        var tex = texOfKatex(node)
        var replacement = document.createElement('span')
        replacement.textContent = tex === '' ? '' : '$' + tex + '$'
        node.parentNode.replaceChild(replacement, node)
      }
      var text = String(holder.textContent || '')
      return text
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim()
    }

    /**
     * Recompute the popover from the current selection: only selections inside
     * the main conversation transcript, outside the composer and the right
     * sidebar, qualify.
     */
    function computeSelection() {
      if (typeof window === 'undefined' || typeof document === 'undefined') return
      var selection = window.getSelection()
      if (selection === null || selection.isCollapsed === true || selection.rangeCount === 0) {
        hidePopover()
        return
      }
      var range = selection.getRangeAt(0)
      var anchor = range.startContainer
      var element = anchor.nodeType === 3 ? anchor.parentElement : anchor
      if (element === null || element === undefined || typeof element.closest !== 'function') {
        hidePopover()
        return
      }
      if (element.closest('[data-sidebar-right-panel]') !== null) {
        hidePopover()
        return
      }
      if (element.closest('[data-slot="conversation.composer.bar"]') !== null) {
        hidePopover()
        return
      }
      if (element.closest('[data-slot="conversation.session"]') === null) {
        hidePopover()
        return
      }
      var rect = range.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) {
        hidePopover()
        return
      }
      var text = excerptOfRange(range)
      if (text === '' || text.length > 20000) {
        hidePopover()
        return
      }
      popoverText = text
      showPopover(rect)
    }

    /** Debounced recompute: selectionchange fires continuously while dragging. */
    function scheduleSelection() {
      if (popoverFrame !== 0) return
      popoverFrame = setTimeout(function () {
        popoverFrame = 0
        computeSelection()
      }, 160)
    }

    /**
     * Install the selection watcher.
     *
     * @returns disposer removing every listener and the floating node.
     */
    function startSelectionWatcher() {
      if (typeof document === 'undefined') return function () {}
      var onMouseDown = function (event) {
        if (popoverElement !== null && popoverElement.contains(event.target)) return
        hidePopover()
      }
      var onScroll = function () {
        hidePopover()
      }
      document.addEventListener('mouseup', scheduleSelection, true)
      document.addEventListener('keyup', scheduleSelection, true)
      document.addEventListener('selectionchange', scheduleSelection)
      document.addEventListener('mousedown', onMouseDown, true)
      window.addEventListener('scroll', onScroll, true)
      return function () {
        document.removeEventListener('mouseup', scheduleSelection, true)
        document.removeEventListener('keyup', scheduleSelection, true)
        document.removeEventListener('selectionchange', scheduleSelection)
        document.removeEventListener('mousedown', onMouseDown, true)
        window.removeEventListener('scroll', onScroll, true)
        if (popoverFrame !== 0) clearTimeout(popoverFrame)
        if (popoverElement !== null) {
          popoverElement.remove()
          popoverElement = null
        }
      }
    }
    //#endregion

    //#region components

    /** Fixed Chat selection used by an embedded Conversation occurrence. */
    function FixedChatView(props) {
      return h(React.Fragment, null, props.renderSlot('conversation.session', { view: 'chat' }))
    }

    /**
     * The conversation inside the right-sidebar tab: the shared Conversation
     * content bound to the question session, plus the duplicate-open notice
     * while the main view also retains it.
     */
    function EmbeddedConversation(props) {
      var sessionId = props.sessionId
      var t = props.t
      var session = props.useSession(function (value) {
        return value
      })
      var useSessionRetainInfo = props.useSessionRetainInfo
      var useSessions = props.useSessions
      var mainCount
      if (useSessionRetainInfo !== undefined) {
        mainCount = useSessionRetainInfo(function (info) {
          return info === undefined ? 0 : ((info.retainedBy && info.retainedBy.mainView) || 0)
        })
      } else {
        mainCount = useSessions(function (state) {
          var row = state.byId[sessionId]
          return row === undefined || row.retainedBy === undefined ? 0 : row.retainedBy.mainView || 0
        })
      }
      var activeTargets = props.useConversation(function (value) {
        return value.activeTargets
      })
      var summaryBlank = useSessions(function (state) {
        var row = state.byId[sessionId]
        return row === undefined ? undefined : row.blank
      })

      if (mainCount > 0) {
        return h(
          'div',
          { className: 'dsa-notice', role: 'status' },
          h('div', { className: 'dsa-notice-title' }, t('duplicate.title')),
          h('div', { className: 'dsa-notice-body' }, t('duplicate.body'))
        )
      }

      var shellPhase =
        activeTargets !== undefined && activeTargets.size > 0
          ? 'active'
          : (!session.blank && !session.awaitingFirstTurn) || session.running
            ? 'active'
            : session.promptAttempted
              ? 'engaging'
              : 'blank'
      var settling = shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true
      var hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true)
      return props.renderFactorySlot(
        'conversation.content',
        { variant: 'embedded', phase: settling ? 'settling' : hero ? 'hero' : 'active', hero: hero },
        { slots: { views: FixedChatView } }
      )
    }

    /** One right-sidebar tab body: bind the retained Session around our slot. */
    function QuestionTab(props) {
      var useResource = props.useResource
      var useTabInfo = props.useTabInfo
      var SessionProvider = props.SessionProvider
      var renderSlot = props.renderSlot
      var t = props.t
      var tab
      try {
        tab = useTabInfo().tab
      } catch (_tabNotCommitted) {
        tab = undefined
      }
      var resource = useResource(tab === undefined ? '' : tab.contentId)
      var children = null
      if (resource !== undefined && resource.value !== undefined) {
        children = h(SessionProvider, { session: resource.value.reference }, renderSlot(SLOT_CONVERSATION, {}))
      } else if (resource !== undefined && resource.status === 'failed') {
        children = h(
          'div',
          { className: 'dsa-notice', role: 'status' },
          h('div', { className: 'dsa-notice-title' }, t('open.failed.title')),
          h('div', { className: 'dsa-notice-body' }, t('open.failed.body'))
        )
      }
      var sessionId = resource !== undefined && resource.value !== undefined ? resource.value.sessionId : undefined
      return h(
        'div',
        {
          className: 'dsa-root',
          'data-study-ask': '',
          'data-study-ask-session': sessionId === undefined ? undefined : sessionId
        },
        children
      )
    }

    /** The tab chip title. */
    function QuestionTabTitle(props) {
      return props.t('tab.title')
    }

    /**
     * Composer control: open this conversation's question chat in the sidebar
     * (creating it on first use, no quote).
     */
    function AskEntryButton(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dsa-entry',
          'data-study-ask-entry': '',
          title: props.t('entry.hint'),
          'aria-label': props.t('entry.ask'),
          onClick: function () {
            openQuestionChat(props.sessionId, null)
          }
        },
        h('span', { className: 'dsa-entry-label' }, props.t('entry.ask'))
      )
    }
    //#endregion

    //#region css

    var CSS_ID = 'dsh-study-ask/style.css'
    var CSS =
      '.dsa-root{width:100%;min-width:0;height:100%;min-height:0;display:flex;flex-direction:column}' +
      '.dsa-notice{padding:24px 20px;display:flex;flex-direction:column;gap:8px;font-size:13px;' +
      'line-height:20px;color:var(--dsw-alias-label-secondary,#666);height:100%;box-sizing:border-box}' +
      '.dsa-notice-title{font-weight:600;color:var(--dsw-alias-label-primary,#111)}' +
      '.dsa-notice-body{max-width:44em}' +
      '.dsa-pop{position:fixed;z-index:9998;display:none;align-items:center;justify-content:center;' +
      'height:30px;min-width:64px;padding:0 12px;border-radius:999px;cursor:pointer;' +
      'font-family:inherit;font-size:12px;line-height:30px;font-weight:500;white-space:nowrap;' +
      'background-color:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);' +
      'background-image:linear-gradient(var(--dsw-specific-menu,rgba(248,249,250,.58)),' +
      'var(--dsw-specific-menu,rgba(248,249,250,.58)));' +
      'border:1px solid var(--dsw-alias-border-1,rgba(0,0,0,.10));' +
      'box-shadow:var(--dsw-elevation-prominent,0 6px 20px rgba(0,0,0,.18))}' +
      '.dsa-pop[data-dsa-open]{display:inline-flex}' +
      '.dsa-pop:hover{color:var(--dsw-alias-brand-primary,#4d6bfe)}' +
      '.dsa-entry{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 8px;border:0;' +
      'border-radius:6px;background:none;cursor:pointer;font:inherit;font-size:12px;' +
      'color:var(--dsw-alias-label-tertiary,#999);flex:none}' +
      '.dsa-entry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));' +
      'color:var(--dsw-alias-label-primary,#111)}' +
      '.dsa-toast{position:fixed;left:50%;bottom:72px;transform:translateX(-50%);z-index:9999;' +
      'padding:6px 12px;border-radius:8px;font-size:12px;line-height:18px;pointer-events:none;' +
      'background:var(--dsw-alias-bg-layer-3,#2b2b2e);color:var(--dsw-alias-label-primary,#fff);' +
      'box-shadow:var(--dsw-elevation-prominent,0 6px 20px rgba(0,0,0,.28));opacity:1;' +
      'transition:opacity .3s ease}' +
      '.dsa-toast-out{opacity:0}'

    /** Inject the stylesheet once; HMR remounts must refresh it, not stack it. */
    function injectCss() {
      if (typeof document === 'undefined') return
      var existing = document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']')
      if (existing !== null) {
        // A hot-reloaded bundle keeps the old tag: refresh its rules.
        if (existing.textContent !== CSS) existing.textContent = CSS
        return
      }
      var tag = document.createElement('style')
      tag.dataset.plugin = NAME
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }
    //#endregion

    //#region plugin body

    /**
     * Client plugin body: inject copy and style, hide owned sessions, then
     * contribute the resource protocol, the tab type/body/title, the embedded
     * conversation, the selection watcher, and the composer entry point.
     *
     * @param ctx - the client Cordis context.
     */
    function apply(ctx) {
      pluginCtx = ctx
      injectCss()
      syncHiddenCss()
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en })
      }, 'dsh-study-ask: dictionaries')

      ctx.effect(function () {
        return startSelectionWatcher()
      }, 'dsh-study-ask: selection watcher')

      // Keep the left list clean: recover owned ids (deterministic mapping) and
      // refresh the hiding stylesheet whenever the session set changes.
      ctx.effect(function () {
        var lastCount = -1
        var busy = false
        var tick = function () {
          if (busy) return
          busy = true
          var count = -1
          try {
            count = Object.keys(sessionRows(ctx)).length
          } catch (_countError) {
            count = -1
          }
          if (count === lastCount) {
            busy = false
            return
          }
          lastCount = count
          rebuildOwned(ctx)
            .catch(function () {})
            .then(function () {
              busy = false
              syncHiddenCss()
            })
        }
        tick()
        var timer = setInterval(tick, 3000)
        return function () {
          clearInterval(timer)
        }
      }, 'dsh-study-ask: hidden rows')

      var conversationChildren = {}
      conversationChildren[SLOT_CONVERSATION] = { kind: 'single', scope: 'session' }

      ctx.inject(['resources', 'sidebarRightTabs'], function (scope) {
        scope.effect(function () {
          return scope.resources.register(questionResourceProvider(ctx.sessions))
        }, 'dsh-study-ask: resource provider')
        scope.effect(function () {
          return scope.sidebarRightTabs.register({
            id: TAB_ID,
            kind: KIND,
            patterns: [ADDRESS_PREFIX + '**'],
            priority: 'extension',
            canOpen: function (address) {
              return parseAddress(address) !== undefined
            },
            title: function () {
              return ctx.locale.bind(NS)('tab.title')
            }
          })
        }, 'dsh-study-ask: tab type')
        scope.effect(function () {
          return scope.slots.inject('sidebar.right.pane.tab', function () {
            return scope.slots.register(
              { name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS, children: conversationChildren },
              QuestionTab
            )
          })
        }, 'dsh-study-ask: tab body')
        scope.effect(function () {
          return scope.slots.inject('sidebar.right.pane.tab.title', function () {
            return scope.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID, locale: NS }, QuestionTabTitle)
          })
        }, 'dsh-study-ask: tab title')
        scope.effect(function () {
          return scope.slots.inject(SLOT_CONVERSATION, function () {
            return scope.slots.register({ name: SLOT_CONVERSATION, locale: NS }, EmbeddedConversation)
          })
        }, 'dsh-study-ask: conversation')
      })

      ctx.slots.inject('conversation.input.left', function () {
        return ctx.slots.register(
          { name: 'conversation.input.left', id: 'study-ask.entry', order: 850, locale: NS },
          AskEntryButton
        )
      })

      // Debug handle for manual verification from the DevTools console.
      if (typeof window !== 'undefined') {
        window.__dshStudyAsk = {
          map: loadMap,
          owned: ownedSessionIds,
          detId: function (mainId) {
            return deterministicId(mainId)
          },
          rebuild: function () {
            return rebuildOwned(ctx)
          },
          createWithId: function (sessionId) {
            return ctx.sessions.create({ sessionId: sessionId })
          },
          open: function (mainId) {
            return openQuestionChat(mainId === undefined ? mainSessionId(ctx) : mainId, null)
          },
          clear: function () {
            saveMap({})
            ownedIds = {}
            syncHiddenCss()
          }
        }
      }
    }
    //#endregion

    module.exports = {
      name: NAME,
      inject: ['sessions', 'uiWorkspace', 'slots', 'locale', 'sidebarRight'],
      apply: apply
    }
    return module.exports
  }
})
