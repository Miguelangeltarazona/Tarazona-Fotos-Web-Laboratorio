/* Tarazona Fotos V26 — Appwrite adapter
 * Keeps the V25 UI/data layer mostly intact while using Appwrite Auth,
 * TablesDB, Storage and Functions underneath.
 */
(() => {
  const ENDPOINT = 'https://fra.cloud.appwrite.io/v1';
  const PROJECT_ID = '6ac131aa0027074df282';
  const DATABASE_ID = 'public';
  const BUCKET_ID = '6ac133d50029720f81d4';
  const DEFAULT_LIMIT = 5000;

  const client = new Appwrite.Client()
    .setEndpoint(ENDPOINT)
    .setProject(PROJECT_ID);
  const account = new Appwrite.Account(client);
  const tablesDB = new Appwrite.TablesDB(client);
  const storage = new Appwrite.Storage(client);
  const functions = new Appwrite.Functions(client);
  const authListeners = new Set();
  const tableCache = new Map();
  const tableCacheAt = new Map();

  const TABLE_ALIASES = { public_profiles: 'profiles' };

  // The Supabase -> Appwrite migration generated new system $id values for
  // the 13 existing albums. The imported photos still contain their original
  // Supabase album UUID in album_id. Keep that source ID as the app-visible
  // logical id until the albums table is permanently normalized.
  const KNOWN_ALBUM_SOURCE_IDS = {
    'REMEMBER RAVAL 26': '443179cc-4ca5-4300-bb57-e93e9c78385d',
    'ELECCIÓN DE REPRESENTANTES': '78cb6812-0b73-46b0-a86a-41f54d75da5a',
    'FALLAS 2026 CREMA': 'c2a43e68-d841-4caf-bc1b-7d4d93f22019',
    'FALLAS 2026 SABADO 28': '2c2bdef3-5d9e-4245-b362-2aaf777783a1',
    'SEMANA FALLAS VIERNES': '4f220138-a624-42ed-bbe9-6595b98f8ba9',
    'SEMANA FALLERA JUEVES': '31e26ae4-6e93-48dd-b281-97a4e48b9177',
    'CABALGATA DEL NINOT 2026': '51be8d72-1240-4e44-a4e4-aee05e09fc9f',
    'PAELLAS Y RAVAL TALENT 2026': '6b864a7b-7ebf-4514-8bad-35ff4f32fcaf',
    'SOPAR FALLERA MAJOR 2026': '9577a811-32ac-41cf-a5dd-d40c542995e1',
    'SOPAR ORQUESTA PATO FALLA NORD': '116c5a4e-5a64-4fb3-9691-70d227cde54e',
    'FALLEROS DE HONOR 2026': 'd00aea16-494e-406f-8724-328fd38c7c15',
    'CRIDA 2026': '742a4558-8fad-4abe-8c0d-0ac5f7cc7416',
    'ARREPLEGA 2026': '04daf833-f203-44b9-bca9-6879bc822962'
  };
  const normalizeAlbumTitle = value => String(value || '').trim().replace(/\s+/g,' ').toLocaleUpperCase('es-ES');
  const albumSourceIdForTitle = title => KNOWN_ALBUM_SOURCE_IDS[normalizeAlbumTitle(title)] || null;

  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const isPlainObject = value => value && typeof value === 'object' && !Array.isArray(value);
  const stripPct = value => String(value ?? '').replace(/^%+|%+$/g, '');
  const normalizeError = (error) => error instanceof Error ? error : new Error(error?.message || String(error || 'Error de Appwrite'));

  function logicalId(row) {
    // Migrated tables such as albums/comments/events have the original
    // application id column empty; their Appwrite $id is the usable row id.
    return row?.id || row?.$id || null;
  }

  function prepareRow(row, table) {
    const out = { ...(row || {}) };
    if (table === 'albums') {
      // Prefer a real persisted id when present; otherwise recover the
      // original source UUID from the album title so photo relations work.
      if (!out.id) out.id = albumSourceIdForTitle(out.title) || out.$id || null;
    } else if (!out.id && out.$id) {
      // Keep a stable app-level id even when the migrated row only has
      // Appwrite's system $id. This is especially important for photos,
      // which are referenced by album/favorite/comment relations.
      out.id = out.$id;
    }
    return out;
  }

  async function rawRows(table) {
    const realTable = TABLE_ALIASES[table] || table;
    const now = Date.now();
    const stamp = tableCacheAt.get(realTable) || 0;
    if (tableCache.has(realTable) && now - stamp < 5000) return tableCache.get(realTable).map(clone);
    try {
      const rows = [];
      let cursor = null;
      // Appwrite caps a single listRows request at 5000 rows. Walk by cursor
      // so the photo library keeps working when a table grows beyond that.
      do {
        const queries = [Appwrite.Query.limit(DEFAULT_LIMIT)];
        if (cursor) queries.push(Appwrite.Query.cursorAfter(cursor));
        const response = await tablesDB.listRows({
          databaseId: DATABASE_ID,
          tableId: realTable,
          queries
        });
        const page = response.rows || [];
        rows.push(...page);
        if (page.length < DEFAULT_LIMIT) break;
        const last = page[page.length - 1];
        const nextCursor = last?.$id || null;
        if (!nextCursor || nextCursor === cursor) break;
        cursor = nextCursor;
      } while (cursor);

      const preparedRows = rows.map(row => prepareRow(row, realTable));
      tableCache.set(realTable, preparedRows.map(clone));
      tableCacheAt.set(realTable, now);
      return preparedRows;
    } catch (error) {
      throw normalizeError(error);
    }
  }

  function invalidate(table) {
    const realTable = TABLE_ALIASES[table] || table;
    tableCache.delete(realTable);
    tableCacheAt.delete(realTable);
  }

  function splitTopLevel(text) {
    const parts = [];
    let depth = 0, start = 0, quote = null;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote) { if (ch === quote && text[i - 1] !== '\\') quote = null; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) { parts.push(text.slice(start, i).trim()); start = i + 1; }
    }
    if (start < text.length) parts.push(text.slice(start).trim());
    return parts.filter(Boolean);
  }

  function parseSelectSpec(spec) {
    const text = String(spec || '*').trim();
    if (text === '*') return { all: true, fields: [], relations: [] };
    const fields = [];
    const relations = [];
    for (const token of splitTopLevel(text)) {
      const m = token.match(/^([A-Za-z0-9_]+)\((.*)\)$/s);
      if (m) relations.push({ table: m[1], fields: m[2] });
      else fields.push(token.trim());
    }
    return { all: false, fields, relations };
  }

  function compareValues(a, b) {
    const aa = a == null ? '' : a;
    const bb = b == null ? '' : b;
    if (typeof aa === 'number' && typeof bb === 'number') return aa - bb;
    const da = Date.parse(String(aa));
    const db = Date.parse(String(bb));
    if (!Number.isNaN(da) && !Number.isNaN(db) && String(aa).includes('-')) return da - db;
    return String(aa).localeCompare(String(bb), 'es', { numeric: true, sensitivity: 'base' });
  }

  function parseOrExpression(expr) {
    const s = String(expr || '').trim();
    const groups = [];
    let depth = 0, current = '', groupsRaw = [];
    for (const ch of s) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      current += ch;
      if (ch === ',' && depth === 0) { groupsRaw.push(current.slice(0, -1)); current = ''; }
    }
    if (current) groupsRaw.push(current);
    for (const raw of groupsRaw) {
      const m = raw.match(/^and\((.*)\)$/i);
      const inner = m ? m[1] : raw;
      const conds = splitTopLevel(inner).map(part => {
        const mm = part.match(/^([A-Za-z0-9_$]+)\.(eq|neq|gte|lte|gt|lt)\.(.*)$/i);
        return mm ? { field: mm[1], op: mm[2].toLowerCase(), value: mm[3] } : null;
      }).filter(Boolean);
      if (conds.length) groups.push(conds);
    }
    return groups;
  }

  function matches(row, filters) {
    for (const f of filters) {
      const val = logicalId(row) && f.field === 'id' ? logicalId(row) : row[f.field];
      switch (f.op) {
        case 'eq': if (Array.isArray(f.value) ? !f.value.includes(val) : val !== f.value) return false; break;
        case 'in': if (!f.value.includes(val)) return false; break;
        case 'neq': if (Array.isArray(f.value) ? f.value.includes(val) : val === f.value) return false; break;
        case 'not_is_null': if (val == null) return false; break;
        case 'gte': if (compareValues(val, f.value) < 0) return false; break;
        case 'lte': if (compareValues(val, f.value) > 0) return false; break;
        case 'ilike': if (!String(val ?? '').toLocaleLowerCase('es').includes(stripPct(f.value).toLocaleLowerCase('es'))) return false; break;
      }
    }
    if (filters._ors?.length) {
      const ok = filters._ors.some(group => group.every(c => {
        const val = logicalId(row) && c.field === 'id' ? logicalId(row) : row[c.field];
        if (c.op === 'eq') return String(val) === String(c.value);
        if (c.op === 'neq') return String(val) !== String(c.value);
        const cmp = compareValues(val, c.value);
        if (c.op === 'gte') return cmp >= 0;
        if (c.op === 'lte') return cmp <= 0;
        if (c.op === 'gt') return cmp > 0;
        if (c.op === 'lt') return cmp < 0;
        return false;
      }));
      if (!ok) return false;
    }
    return true;
  }

  async function relationRows(relationTable, ids) {
    const wanted = new Set(ids.filter(Boolean).map(String));
    if (!wanted.size) return [];
    const rows = await rawRows(TABLE_ALIASES[relationTable] || relationTable);
    const real = TABLE_ALIASES[relationTable] || relationTable;
    return rows.filter(r => {
      if (real === 'photos') return wanted.has(String(r.id || '')) || wanted.has(String(r.$id || ''));
      return wanted.has(String(r.id || r.$id || ''));
    });
  }

  async function applyRelations(table, rows, spec) {
    if (!spec.relations.length) return rows;
    let out = rows.map(clone);
    for (const rel of spec.relations) {
      const relTable = TABLE_ALIASES[rel.table] || rel.table;
      if (table === 'favorites' && relTable === 'photos') {
        const map = new Map();
        for (const p of await relationRows('photos', out.map(r => r.photo_id))) {
          if (p.id != null) map.set(String(p.id), p);
          if (p.$id != null) map.set(String(p.$id), p);
        }
        out.forEach(r => { const x = map.get(String(r.photo_id)); if (x) r.photos = parseFields(x, parseSelectSpec(rel.fields)); });
      } else if (table === 'comments' && relTable === 'photos') {
        const map = new Map();
        for (const p of await relationRows('photos', out.map(r => r.photo_id))) {
          if (p.id != null) map.set(String(p.id), p);
          if (p.$id != null) map.set(String(p.$id), p);
        }
        out.forEach(r => { const x = map.get(String(r.photo_id)); if (x) r.photos = parseFields(x, parseSelectSpec(rel.fields)); });
      } else if (table === 'comments' && relTable === 'profiles') {
        const map = new Map((await relationRows('profiles', out.map(r => r.user_id))).flatMap(p => [[String(p.id || ''), p],[String(p.$id || ''), p]].filter(([k]) => k)));
        out.forEach(r => { const x = map.get(String(r.user_id)); if (x) r.profiles = parseFields(x, parseSelectSpec(rel.fields)); });
      } else if (table === 'removal_requests' && relTable === 'photos') {
        const map = new Map();
        for (const p of await relationRows('photos', out.map(r => r.photo_id))) {
          if (p.id != null) map.set(String(p.id), p);
          if (p.$id != null) map.set(String(p.$id), p);
        }
        out.forEach(r => { const x = map.get(String(r.photo_id)); if (x) r.photos = parseFields(x, parseSelectSpec(rel.fields)); });
      } else if (table === 'removal_requests' && relTable === 'profiles') {
        const map = new Map((await relationRows('profiles', out.map(r => r.user_id))).flatMap(p => [[String(p.id || ''), p],[String(p.$id || ''), p]].filter(([k]) => k)));
        out.forEach(r => { const x = map.get(String(r.user_id)); if (x) r.profiles = parseFields(x, parseSelectSpec(rel.fields)); });
      } else if (table === 'photos' && relTable === 'albums') {
        // album_id in photos keeps the original source album UUID; album rows expose the same logical id.
        const map = new Map();
        for (const a of await relationRows('albums', out.map(r => r.album_id))) {
          if (a.id != null) map.set(String(a.id), a);
          if (a.$id != null) map.set(String(a.$id), a);
        }
        out.forEach(r => { const x = map.get(String(r.album_id)); if (x) r.albums = parseFields(x, parseSelectSpec(rel.fields)); });
      }
    }
    return out;
  }

  function parseFields(row, spec) {
    if (spec.all) return clone(row);
    const out = {};
    for (const f of spec.fields) if (f in row) out[f] = row[f];
    // App code relies on logical id from albums/comments/etc. even though the
    // imported user id column was absent when those rows were created.
    if (spec.fields.includes('id') && row.id == null && row.$id) out.id = row.$id;
    for (const rel of spec.relations) {
      const key = rel.table === 'public_profiles' ? 'public_profiles' : rel.table;
      if (key in row) out[key] = clone(row[key]);
    }
    return out;
  }

  class QueryBuilder {
    constructor(table) { this.table = table; this.spec = { all: true, fields: [], relations: [] }; this.filters = []; this.orders = []; this.max = null; this.head = false; this._or = null; }
    select(fields = '*', options = {}) { this.spec = parseSelectSpec(fields); this.head = options?.head === true; return this; }
    eq(field, value) { this.filters.push({field, op:'eq', value}); return this; }
    in(field, values) { this.filters.push({field, op:'in', value:Array.isArray(values)?values:[]}); return this; }
    neq(field, value) { this.filters.push({field, op:'neq', value}); return this; }
    not(field, op, value) { if (op === 'is' && value === null) this.filters.push({field, op:'not_is_null'}); return this; }
    gte(field, value) { this.filters.push({field, op:'gte', value}); return this; }
    lte(field, value) { this.filters.push({field, op:'lte', value}); return this; }
    ilike(field, value) { this.filters.push({field, op:'ilike', value}); return this; }
    or(expr) { this._or = parseOrExpression(expr); return this; }
    order(field, options = {}) { this.orders.push({field, ascending: options?.ascending !== false}); return this; }
    limit(n) { this.max = Number(n) || 0; return this; }
    async maybeSingle() { const r = await this.exec(); return { data: r.data?.[0] || null, error: r.error || null, count: r.count ?? null }; }
    async exec() {
      try {
        let rows = await rawRows(this.table);
        const allFilters = this.filters.slice();
        if (this._or?.length) allFilters._ors = this._or;
        rows = rows.filter(r => matches(r, allFilters));
        for (let i = this.orders.length - 1; i >= 0; i--) {
          const o = this.orders[i];
          rows.sort((a,b) => { const av = o.field === 'id' ? logicalId(a) : a[o.field]; const bv = o.field === 'id' ? logicalId(b) : b[o.field]; const cmp = compareValues(av,bv); return o.ascending ? cmp : -cmp; });
        }
        const total = rows.length;
        if (this.max != null) rows = rows.slice(0, Math.max(0,this.max));
        rows = await applyRelations(this.table, rows, this.spec);
        const data = rows.map(r => parseFields(r, this.spec));
        return { data: this.head ? null : data, error: null, count: total };
      } catch (error) {
        return { data: null, error: normalizeError(error), count: null };
      }
    }
    then(resolve, reject) { return this.exec().then(resolve, reject); }
    catch(reject) { return this.exec().catch(reject); }
  }

  function withError(promise) {
    return promise.then(data => ({ data, error: null }), error => ({ data: null, error: normalizeError(error) }));
  }

  function newId() {
    return crypto.randomUUID();
  }

  async function upsert(table, payload) {
    const realTable = TABLE_ALIASES[table] || table;
    const keyField = realTable === 'user_preferences' ? 'user_id' : (payload?.id != null ? 'id' : '$id');
    const existing = keyField === '$id' ? [] : (await rawRows(realTable)).filter(r => String(r[keyField] ?? '') === String(payload[keyField] ?? ''));
    if (existing[0]) {
      const row = await tablesDB.updateRow({ databaseId: DATABASE_ID, tableId: realTable, rowId: existing[0].$id, data: payload });
      invalidate(realTable); return prepareRow(row, realTable);
    }
    const row = await tablesDB.createRow({ databaseId: DATABASE_ID, tableId: realTable, rowId: newId(), data: payload });
    invalidate(realTable); return prepareRow(row, realTable);
  }

  async function insert(table, payload) {
    const realTable = TABLE_ALIASES[table] || table;
    const data = { ...(payload || {}) };
    const knownWithIdColumn = ['albums','photos','comments','removal_requests','notifications','events','places','site_settings','profiles','user_preferences','featured_photo_likes'].includes(realTable);
    if (knownWithIdColumn && realTable !== 'site_settings' && realTable !== 'user_preferences' && data.id == null) data.id = newId();
    if (realTable === 'site_settings' && data.id == null) data.id = 1;
    const row = await tablesDB.createRow({ databaseId: DATABASE_ID, tableId: realTable, rowId: newId(), data });
    invalidate(realTable); return prepareRow(row, realTable);
  }

  async function update(table, payload, filters) {
    const realTable = TABLE_ALIASES[table] || table;
    const rows = (await rawRows(realTable)).filter(r => matches(r, filters || []));
    const updated = [];
    for (const row of rows) {
      const x = await tablesDB.updateRow({ databaseId: DATABASE_ID, tableId: realTable, rowId: row.$id, data: payload });
      updated.push(prepareRow(x, realTable));
    }
    invalidate(realTable); return updated;
  }

  async function remove(table, filters) {
    const realTable = TABLE_ALIASES[table] || table;
    const rows = (await rawRows(realTable)).filter(r => matches(r, filters || []));
    for (const row of rows) await tablesDB.deleteRow({ databaseId: DATABASE_ID, tableId: realTable, rowId: row.$id });
    invalidate(realTable); return rows.map(r => prepareRow(r, realTable));
  }

  function mutationBuilder(table, type, payload) {
    const filters = [];
    const b = {
      eq(field, value) { filters.push({field,op:'eq',value}); return b; },
      in(field, values) { filters.push({field,op:'in',value}); return b; },
      neq(field, value) { filters.push({field,op:'neq',value}); return b; },
      then(resolve,reject) { return b.exec().then(resolve,reject); },
      catch(reject) { return b.exec().catch(reject); },
      async exec() {
        try {
          let data;
          if (type === 'insert') data = await insert(table, payload);
          else if (type === 'update') data = await update(table, payload, filters);
          else data = await remove(table, filters);
          return {data: Array.isArray(data) ? data : data, error:null};
        } catch (error) { return {data:null,error:normalizeError(error)}; }
      }
    };
    return b;
  }

  async function currentAppwriteUser() {
    try { return await account.get(); } catch { return null; }
  }

  function mapUser(user) {
    if (!user) return null;
    return { id:user.$id, email:user.email, name:user.name, user_metadata:{ full_name:user.name }, appwrite:user };
  }

  const sb = {
    from(table) {
      return {
        select(fields='*', options={}) { return new QueryBuilder(table).select(fields, options); },
        insert(payload) { return mutationBuilder(table, 'insert', payload); },
        update(payload) { return mutationBuilder(table, 'update', payload); },
        delete() { return mutationBuilder(table, 'delete'); },
        upsert(payload) { return { then: (resolve,reject) => upsert(table,payload).then(data => resolve({data,error:null}), reject), catch: reject => upsert(table,payload).catch(reject) }; }
      };
    },
    auth: {
      async getSession() {
        const u = await currentAppwriteUser();
        const user = mapUser(u);
        return { data:{ session:user ? { user, access_token:'appwrite-session' } : null }, error:null };
      },
      async getUser() {
        const u = await currentAppwriteUser();
        return { data:{ user:mapUser(u) }, error:null };
      },
      onAuthStateChange(fn) { authListeners.add(fn); return { data:{ subscription:{ unsubscribe:()=>authListeners.delete(fn) } } }; },
      async signInWithPassword({email,password}) {
        try { await account.createEmailPasswordSession({email,password}); const u = mapUser(await currentAppwriteUser()); for (const fn of authListeners) fn('SIGNED_IN',{user:u}); return {data:{user:u},error:null}; }
        catch(error) { return {data:null,error:normalizeError(error)}; }
      },
      async signUp({email,password,options={}}) {
        try {
          const name = options?.data?.full_name || '';
          const u = await account.create({userId:Appwrite.ID.unique(),email,password,name});
          // Profile row is kept with the exact Appwrite auth id so existing relations remain coherent.
          try { await insert('profiles',{id:u.$id,full_name:name,email:u.email,role:'member',created_at:new Date().toISOString(),updated_at:new Date().toISOString()}); } catch {}
          return {data:{user:mapUser(u),session:null},error:null};
        } catch(error) { return {data:null,error:normalizeError(error)}; }
      },
      async resetPasswordForEmail(email,{redirectTo}={}) {
        try { await account.createRecovery(email, redirectTo || window.location.origin); return {data:{},error:null}; }
        catch(error) { return {data:null,error:normalizeError(error)}; }
      },
      async updateUser({password,data}={}) {
        try {
          const recoveryUser = new URLSearchParams(location.search).get('userId');
          const secret = new URLSearchParams(location.search).get('secret');
          if (password && recoveryUser && secret) await account.updateRecovery(recoveryUser, secret, password);
          else if (password) await account.updatePassword(password);
          if (data?.full_name != null) await account.updateName(data.full_name);
          return {data:{user:mapUser(await currentAppwriteUser())},error:null};
        } catch(error) { return {data:null,error:normalizeError(error)}; }
      },
      async signOut() {
        try { await account.deleteSession({sessionId:'current'}); cachedAuthReset(); for (const fn of authListeners) fn('SIGNED_OUT',null); return {error:null}; }
        catch(error) { return {error:normalizeError(error)}; }
      }
    },
    storage: {
      from(bucket) {
        const bucketId = BUCKET_ID;
        return {
          async createSignedUrl(fileId) {
            try { return {data:{signedUrl:storage.getFileView({bucketId,fileId})},error:null}; }
            catch(error) { return {data:null,error:normalizeError(error)}; }
          },
          async remove(paths) {
            try { for (const p of paths || []) await storage.deleteFile({bucketId,fileId:String(p)}); return {data:null,error:null}; }
            catch(error) { return {data:null,error:normalizeError(error)}; }
          }
        };
      }
    },
    functions: {
      async invoke(functionName, options={}) {
        try {
          const [requestedFunctionId, query = ''] = String(functionName).split('?');
          const FUNCTION_IDS = {
            'dropbox-media': '6ac539a60010c601435a',
            'site-admin': '6ac558e6002b3f909ae7'
          };
          const functionId = FUNCTION_IDS[requestedFunctionId] || requestedFunctionId;
          let body = options.body ?? {};
          if (body instanceof FormData) {
            const form = {};
            for (const [key,value] of body.entries()) {
              if (value instanceof File) {
                const bytes = new Uint8Array(await value.arrayBuffer());
                form.file = {name:value.name,type:value.type,size:value.size,base64:bytesToBase64(bytes)};
              } else form[key] = value;
            }
            // adminCall() serializes its domain payload in the FormData 'payload' field;
            // turn that back into a normal JSON object for the Appwrite Function.
            if (typeof form.payload === 'string') {
              let parsed = {};
              try { parsed = JSON.parse(form.payload) || {}; } catch {}
              body = { action: form.action || '', ...parsed };
              if (form.file) body.file = form.file;
            } else body = form;
          }
          const execution = await functions.createExecution({
            functionId,
            body: typeof body === 'string' ? body : JSON.stringify(body),
            async:false,
            // Appwrite Web SDK 19 names the execution path option `xpath`.
            xpath: '/' + (query ? '?' + query : ''),
            method: options.method || 'POST',
            headers: {'Content-Type':'application/json', ...(options.headers || {})}
          });
          let data = {};
          try { data = execution.responseBody ? JSON.parse(execution.responseBody) : {}; }
          catch { data = {raw:execution.responseBody || ''}; }
          const error = execution.responseStatusCode >= 400 ? new Error(data?.error || `Function ${functionId} devolvió ${execution.responseStatusCode}`) : null;
          return {data,error};
        } catch(error) { return {data:null,error:normalizeError(error)}; }
      }
    }
  };

  function bytesToBase64(bytes) {
    let out = '';
    const chunk = 0x8000;
    for (let i=0; i<bytes.length; i+=chunk) out += String.fromCharCode(...bytes.subarray(i, Math.min(i+chunk, bytes.length)));
    return btoa(out);
  }

  function cachedAuthReset() { window.__tfAppwriteLoggedOut = true; }

  // Expose config for the page and diagnostics.
  window.TF_APPWRITE = {ENDPOINT,PROJECT_ID,DATABASE_ID,BUCKET_ID,client,account,tablesDB,storage,functions};
  window.sb = sb;
})();
