// Token Radar's dashboard, radar-2. It reads window.RADAR (written beside dashboard/ by
// main.ts) and renders the ranked board, a filterable table, a per-protocol detail view
// with the model's own inputs and the protocol's farm plan, and the top three as the
// answer at a glance. No network: every byte it shows is in data.js.
(function () {
  'use strict';

  var RADAR = window.RADAR;
  if (!RADAR) return;
  var mount = document.getElementById('board');
  var view = {
    query: '',
    category: 'all',
    chain: 'all',
    watchOnly: false,
    tab: 'pre-token',
    sortBy: 'implied',
    direction: -1,
    detail: null
  };

  var moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  /** A dollar figure, shortened past a thousand. */
  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return moneyFmt.format(n);
  }
  /** A percentage with its sign. */
  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  /** An age in days as years past one, else days. */
  function ageLabel(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }

  // The model in one function: the page recomputes a row from the snapshot figures and
  // checks the number board.json carries, so the page's code and the board's data are
  // visibly the same arithmetic.
  function recompute(row, model) {
    var change = row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d;
    var growth = Math.min(model.growth_cap, Math.max(model.growth_floor, change));
    var growthMult = 1 + (growth / 100) * model.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    var maturity = model.maturity_floor +
      (Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
    var chains = (row.chains || []).length;
    var chainMult = 1 + Math.min(Math.max(chains - 1, 0), model.chain_cap) * model.chain_weight;
    return Math.max(1, Math.round(row.tvl_usd * model.base_multiple * growthMult * maturity * chainMult));
  }

  /** Build an element: tag, attributes, then children. `onX` attributes are listeners. */
  function node(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') el.className = attrs[k];
        else if (k === 'text') el.textContent = attrs[k];
        else if (k === 'html') el.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) el.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) {
        child.forEach(function (c) { if (c) el.appendChild(c); });
      } else if (typeof child === 'string') {
        el.appendChild(document.createTextNode(child));
      } else {
        el.appendChild(child);
      }
    }
    return el;
  }

  // The farm plan is the same derivation main.ts writes to board.json: category, chains,
  // TVL and age decide the action, the capital, the hold and every cost and time.
  // No name is special-cased.
  function firstChain(p) {
    if (p.chains && p.chains.length > 0) return p.chains[0];
    return 'its main chain';
  }
  function stake(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }
  function holdDays(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function mainStep(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) {
      return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open.';
    }
    if (c.indexOf('dex') >= 0 || c.indexOf('yield') >= 0 || c.indexOf('leveraged farm') >= 0) {
      return 'Provide $' + capital + ' of liquidity to ' + name + '\'s main pool on ' + chain + ' and keep the position open.';
    }
    if (c.indexOf('bridge') >= 0) {
      return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.';
    }
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) {
      return 'Stake $' + capital + ' of the chain\'s staking asset through ' + name + ' and keep the receipt.';
    }
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0) {
      return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedge.';
    }
    if (c.indexOf('prediction') >= 0) {
      return 'Fund $' + capital + ' and place one market position on ' + name + '.';
    }
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) {
      return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the shares.';
    }
    if (c.indexOf('stable') >= 0) {
      return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.';
    }
    if (c.indexOf('rwa') >= 0) {
      return 'Mint $' + capital + ' of the protocol\'s yield asset on ' + chain + ' and hold it.';
    }
    if (c.indexOf('insurance') >= 0) {
      return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy.';
    }
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }
  function extraStep(p, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) {
      return 'Borrow $25 of stablecoin against the supply on ' + name + ', then repay it within the week.';
    }
    if (c.indexOf('dex') >= 0 || c.indexOf('yield') >= 0 || c.indexOf('leveraged farm') >= 0) {
      return 'Swap $25 through ' + name + '\'s pool on ' + chain + ' once, so the wallet shows trading as well as liquidity.';
    }
    if (c.indexOf('bridge') >= 0) {
      return 'Bridge $25 back to the chain you started from, so the wallet shows two-way use of ' + name + '.';
    }
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) {
      return 'Delegate a second, smaller stake through ' + name + ' on ' + chain + ' and keep both receipts.';
    }
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0) {
      return 'Close the hedge on ' + name + ' and open one small position in the other direction.';
    }
    if (c.indexOf('prediction') >= 0) {
      return 'Settle the first market position on ' + name + ' and place one more.';
    }
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) {
      return 'Deposit $25 into a second ' + name + ' vault on ' + chain + ' and keep the shares.';
    }
    if (c.indexOf('stable') >= 0) {
      return 'Redeem a small amount of the stable asset from ' + name + ' and mint it again.';
    }
    if (c.indexOf('rwa') >= 0) {
      return 'Claim any yield the position accrued on ' + name + ' and restake it.';
    }
    if (c.indexOf('insurance') >= 0) {
      return 'Open the policy page on ' + name + ' and confirm the cover is active.';
    }
    return 'Use a second feature of ' + name + ' once, such as a swap or a vote, so the wallet is not single-action.';
  }
  function asText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + ' Hold the position and check the protocol\'s own page.';
    return s;
  }
  function plan(p) {
    var chain = firstChain(p);
    var capital = stake(p);
    var hold = holdDays(p.age_days);
    var gas = capital >= 150 ? 8 : 4;
    return [
      {
        text: 'Use a fresh wallet that holds only the funds you plan to farm, ' +
          'and keep its seed phrase offline.',
        cost: 'under $3 of gas for the first transaction',
        time: '5 minutes'
      },
      {
        text: mainStep(p, capital, chain),
        cost: '$' + capital + ' of capital and about $' + gas + ' of gas',
        time: '15 minutes to set up'
      },
      {
        text: extraStep(p, chain),
        cost: 'about $25 of capital and $2 of gas',
        time: '10 minutes'
      },
      {
        text: 'Make one qualifying action each week, such as a deposit, ' +
          'a borrow, a swap or a vote.',
        cost: 'about $2 of gas a week',
        time: '10 minutes a week'
      },
      {
        text: 'Hold the position for at least ' + hold + ' days so the activity ' +
          'is counted in more than one snapshot.',
        cost: 'the $' + capital + ' stays in the position',
        time: hold + ' days'
      },
      {
        text: 'Before you withdraw, open the protocol\'s own points or rewards page ' +
          'and claim only from the link it publishes.',
        cost: 'no fee to check, and never pay to claim',
        time: '10 minutes'
      },
      {
        text: 'Write the wallet, the dates and every transaction in a farm log, ' +
          'and plan the unwind before the token launches.',
        cost: 'nothing but the log',
        time: '5 minutes'
      }
    ].map(asText);
  }

  /** Read the view out of the URL hash, so a filtered board and an open detail link. */
  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) view.query = params.get('q');
    if (params.get('p')) view.detail = params.get('p');
    if (params.get('category')) view.category = params.get('category');
    if (params.get('chain')) view.chain = params.get('chain');
    if (params.get('w') === '1') view.watchOnly = true;
    if (params.get('tab')) view.tab = params.get('tab');
  }
  /** Write the view back into the URL hash, without adding a history entry. */
  function writeHash() {
    var params = new URLSearchParams();
    if (view.query) params.set('q', view.query);
    if (view.category !== 'all') params.set('category', view.category);
    if (view.chain !== 'all') params.set('chain', view.chain);
    if (view.watchOnly) params.set('w', '1');
    if (view.tab !== 'pre-token') params.set('tab', view.tab);
    if (view.detail) params.set('p', view.detail);
    var next = params.toString();
    var base = window.location.pathname + window.location.search;
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', base);
  }

  /** The pre-token rows the current filters leave standing. */
  function visibleRows() {
    var q = view.query.trim().toLowerCase();
    return RADAR.rows.filter(function (r) {
      if (view.watchOnly && !r.watchlist) return false;
      if (view.category !== 'all' && r.category !== view.category) return false;
      if (view.chain !== 'all' && (r.chains || []).indexOf(view.chain) < 0) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  /** A row list in the view's sort order, ties broken by slug. */
  function orderedRows(list) {
    var key = view.sortBy;
    var dir = view.direction;
    return list.slice().sort(function (a, b) {
      var av;
      var bv;
      if (key === 'name') {
        av = a.name.toLowerCase();
        bv = b.name.toLowerCase();
      } else if (key === 'tvl') {
        av = a.tvl_usd;
        bv = b.tvl_usd;
      } else if (key === 'growth') {
        av = a.change_7d === null ? -Infinity : a.change_7d;
        bv = b.change_7d === null ? -Infinity : b.change_7d;
      } else if (key === 'age') {
        av = a.age_days === null ? Infinity : a.age_days;
        bv = b.age_days === null ? Infinity : b.age_days;
      } else if (key === 'chains') {
        av = (a.chains || []).length;
        bv = (b.chains || []).length;
      } else {
        av = a.implied_value_usd;
        bv = b.implied_value_usd;
      }
      if (av < bv) return -dir;
      if (av > bv) return dir;
      if (a.slug < b.slug) return -1;
      if (a.slug > b.slug) return 1;
      return 0;
    });
  }

  /** Whether any filter is on, so the top three say so. */
  function filtered() {
    return view.query.trim() !== '' || view.category !== 'all' || view.chain !== 'all' || view.watchOnly;
  }

  function header() {
    return node('header', { class: 'top' },
      node('div', { class: 'brand' },
        node('span', { class: 'mark' }),
        node('span', { class: 'brand-name', text: 'Token Radar' })),
      node('div', { class: 'top-meta' },
        node('span', { text: 'Snapshot ' + RADAR.as_of }),
        node('span', { text: 'DefiLlama protocol index' }),
        node('span', { text: RADAR.model_version + ' model' })));
  }

  function lede() {
    var floorM = Math.round(RADAR.floor_usd / 1e6);
    return node('section', { class: 'lede' },
      node('div', null,
        node('h1', { text: RADAR.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        node('p', { text: 'The watchlist is the floor: every protocol with at least $' + floorM +
          'M of TVL and no token on record. The early radar adds ' + RADAR.early_size +
          ' pre-token protocols below that floor, the whole pre-token universe the snapshot carries. ' +
          'Implied value is a model, not a promise.' })),
      node('div', { class: 'facts' },
        node('div', { class: 'fact' },
          node('span', { text: 'Watchlist covered' }),
          node('b', { text: RADAR.watchlist_size + ' / ' + RADAR.watchlist_size })),
        node('div', { class: 'fact' },
          node('span', { text: 'Pre-token rows scored' }),
          node('b', { text: String(RADAR.board_size) })),
        node('div', { class: 'fact' },
          node('span', { text: 'Early rows below the floor' }),
          node('b', { text: String(RADAR.early_size) })),
        node('div', { class: 'fact' },
          node('span', { text: 'Live-token protocols set aside' }),
          node('b', { text: String(RADAR.live_size) }))));
  }

  function top3() {
    if (view.tab === 'live') {
      var live = RADAR.live.slice().sort(function (a, b) {
        return (b.mcap_usd || 0) - (a.mcap_usd || 0);
      }).slice(0, 3);
      return node('section', { class: 'top3', 'aria-label': 'Largest live-token protocols by market cap' },
        live.map(function (r, i) {
          return node('div', { class: 'top3-card', style: 'cursor:default' },
            node('span', { class: 'rank', text: 'LARGEST LIVE \u00b7 #' + (i + 1) }),
            node('b', { text: r.name }),
            node('span', { class: 'val', text: money(r.mcap_usd) + ' market cap' }),
            node('span', { class: 'sub', text: (r.category || 'Other') + ' \u00b7 ' + money(r.tvl_usd) +
              ' TVL \u00b7 ' + pct(r.change_7d) + ' in 7 days' }));
        }));
    }
    var isFiltered = filtered();
    var cards = visibleRows().slice().sort(function (a, b) {
      return b.implied_value_usd - a.implied_value_usd;
    }).slice(0, 3).map(function (r) {
      return node('button', { type: 'button', class: 'top3-card', onclick: function () { openDetail(r.slug); } },
        node('span', { class: 'rank', text: (isFiltered ? 'TOP IN THIS FILTER \u00b7 RANK ' : 'START HERE \u00b7 RANK ') + r.rank }),
        node('b', { text: r.name }),
        node('span', { class: 'val', text: money(r.implied_value_usd) + ' implied' }),
        node('span', { class: 'sub', text: (r.category || 'Other') + ' \u00b7 ' + money(r.tvl_usd) +
          ' TVL \u00b7 ' + pct(r.change_7d) + ' in 7 days' }));
    });
    return node('section', { class: 'top3', 'aria-label': isFiltered ? 'Top three of the filtered board' : 'Top three by implied value' }, cards);
  }

  function controls() {
    var categories = Array.from(new Set(RADAR.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chainCounts = {};
    RADAR.rows.forEach(function (r) {
      (r.chains || []).forEach(function (c) { chainCounts[c] = (chainCounts[c] || 0) + 1; });
    });
    var chains = Object.keys(chainCounts).sort(function (a, b) { return chainCounts[b] - chainCounts[a]; });
    var search = node('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: view.query, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { view.query = search.value; writeHash(); render(); });
    var select = node('select', { id: 'category', 'aria-label': 'Filter by category' },
      node('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) {
        return node('option', { value: c, text: c, selected: c === view.category ? 'selected' : null });
      }));
    select.addEventListener('change', function () { view.category = select.value; writeHash(); render(); });
    var chainSelect = node('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      node('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) {
        return node('option', { value: c, text: c + ' (' + chainCounts[c] + ')', selected: c === view.chain ? 'selected' : null });
      }));
    chainSelect.addEventListener('change', function () { view.chain = chainSelect.value; writeHash(); render(); });
    var watchCheck = node('label', { class: 'check' },
      node('input', { type: 'checkbox', id: 'watchonly', checked: view.watchOnly ? 'checked' : null }),
      'Watchlist only');
    watchCheck.querySelector('input').addEventListener('change', function (e) {
      view.watchOnly = e.target.checked;
      writeHash();
      render();
    });
    var pre = node('button', { type: 'button', 'aria-pressed': view.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { view.tab = 'pre-token'; render(); } });
    var live = node('button', { type: 'button', 'aria-pressed': view.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { view.tab = 'live'; render(); } });
    return node('div', { class: 'controls' },
      node('div', { class: 'field' }, node('label', { for: 'q', text: 'Search' }), search),
      node('div', { class: 'field' }, node('label', { for: 'category', text: 'Category' }), select),
      node('div', { class: 'field' }, node('label', { for: 'chain', text: 'Chain' }), chainSelect),
      watchCheck,
      node('div', { class: 'field' },
        node('span', { class: 'sub', text: 'Token status' }),
        node('div', { class: 'tabs' }, pre, live)),
      node('span', { class: 'count', text: view.tab === 'pre-token' ? visibleRows().length + ' rows shown' : RADAR.live.length + ' live-token protocols' }));
  }

  /** A sortable column header: click to sort, again to flip. */
  function sortHeader(key, label) {
    return node('th', { scope: 'col' },
      node('button', { type: 'button', onclick: function () {
        if (view.sortBy === key) view.direction = -view.direction;
        else { view.sortBy = key; view.direction = -1; }
        render();
      } },
        label,
        view.sortBy === key ? node('span', { 'aria-hidden': 'true', text: view.direction < 0 ? ' v' : ' ^' }) : null));
  }

  function boardTable() {
    var list = orderedRows(visibleRows());
    if (list.length === 0) {
      return node('div', { class: 'panel' }, node('div', { class: 'empty' },
        node('h2', { text: 'No protocol matches that filter' }),
        node('p', { text: 'Clear the search or pick another category to see the board again.' }),
        node('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () {
          view.query = '';
          view.category = 'all';
          view.chain = 'all';
          view.watchOnly = false;
          writeHash();
          render();
        } })));
    }
    var max = list[0].implied_value_usd || 1;
    var tbody = node('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : pct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var chainsText = (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain');
      var nameCell = node('div', { class: 'name' },
        node('span', null,
          node('b', { text: r.name }),
          r.watchlist ? node('span', { class: 'badge', text: 'WATCHLIST' }) : null),
        node('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + chainsText }));
      var barWidth = Math.max(3, Math.round((r.implied_value_usd / max) * 100));
      var tr = node('tr', {
        'data-selected': view.detail === r.slug ? 'true' : 'false',
        class: r.watchlist ? 'watch' : null,
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); }
        }
      },
        node('td', { class: 'num', text: String(r.rank) }),
        node('td', null, nameCell),
        node('td', { class: 'num', text: money(r.tvl_usd) }),
        node('td', { class: 'num ' + growthClass, text: growth }),
        node('td', { class: 'num', text: ageLabel(r.age_days) }),
        node('td', { class: 'num', text: String((r.chains || []).length) }),
        node('td', null, node('div', { class: 'implied' },
          node('div', { class: 'bar', 'aria-hidden': 'true' },
            node('i', { style: 'width:' + barWidth + '%' })),
          node('span', { class: 'num', text: money(r.implied_value_usd) }))),
        node('td', null, node('span', { class: 'status', text: 'no token' })));
      tbody.appendChild(tr);
    });
    return node('div', { class: 'panel' },
      node('div', { class: 'table-wrap' },
        node('table', null,
          node('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan. Gold edge marks the watchlist.' }),
          node('thead', null, node('tr', null,
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('chains', 'Chains'),
            sortHeader('implied', 'Implied value'),
            node('th', { scope: 'col', text: 'Token' }))),
          tbody)));
  }

  function liveTable() {
    var tbody = node('tbody');
    RADAR.live.forEach(function (r) {
      var chainsText = (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain');
      var growthClass = r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg';
      tbody.appendChild(node('tr', null,
        node('td', { class: 'num', text: 'live' }),
        node('td', null, node('div', { class: 'name' },
          node('b', { text: r.name }),
          node('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + chainsText }))),
        node('td', { class: 'num', text: money(r.tvl_usd) }),
        node('td', { class: 'num ' + growthClass, text: pct(r.change_7d) }),
        node('td', { class: 'num', text: money(r.mcap_usd) }),
        node('td', null, node('span', { class: 'status', text: 'already trades' }))));
    });
    return node('div', { class: 'panel' },
      node('div', { class: 'table-wrap' },
        node('table', null,
          node('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          node('thead', null, node('tr', null,
            node('th', { scope: 'col', text: 'Status' }),
            node('th', { scope: 'col', text: 'Protocol' }),
            node('th', { scope: 'col', text: 'TVL' }),
            node('th', { scope: 'col', text: '7d' }),
            node('th', { scope: 'col', text: 'Market cap' }),
            node('th', { scope: 'col', text: 'Token' }))),
          tbody)));
  }

  function modelPanel() {
    var m = RADAR.model;
    var formula = 'implied = round( tvl_usd x ' + m.base_multiple +
      ' x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ')' +
      ' x (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days +
      ' x ' + m.maturity_range + ')' +
      ' x (1 + min(chains - 1, ' + m.chain_cap + ') x ' + m.chain_weight + ') )';
    return node('section', { class: 'panel model' },
      node('h2', { text: 'How implied value is computed' }),
      node('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked.' }),
      node('div', { class: 'formula' }, formula),
      node('div', { class: 'factors' },
        node('div', { class: 'factor' },
          node('b', { text: 'Size' }),
          node('span', { text: 'TVL x 0.25: the economy a token would price.' })),
        node('div', { class: 'factor' },
          node('b', { text: 'Momentum' }),
          node('span', { text: 'Seven-day growth, clamped -60% to +120%, half-weighted: a launch catches a protocol while it compounds.' })),
        node('div', { class: 'factor' },
          node('b', { text: 'Maturity' }),
          node('span', { text: 'Age with no token, 0.6 rising to 1.0 over three years: longer tokenless runs have more users to reward.' })),
        node('div', { class: 'factor' },
          node('b', { text: 'Reach' }),
          node('span', { text: 'Each extra chain adds 4%, capped at five: more chains reach more wallets that could hold the token.' }))),
      node('p', { class: 'sub', text: 'Age is the time since the protocol was first listed, the best record of how long it has run with no token; an unlisted age uses ' + m.unknown_age_days + ' days. The early radar is every pre-token protocol below the watchlist floor, by TVL, and the live-token protocols are set aside with their market caps shown.' }),
      node('p', { class: 'sub', text: 'Left out on purpose: 63 rankable protocols above the $50M floor are not on this board — the snapshot\u2019s watchlist does not carry them, and most are wrapped, staked or bridged versions of a token that already trades. Scored by this same function, WBTC would read $1.4B and Binance staked ETH $1.8B, each above the board\u2019s top row; ranking them would crown a wrapped Bitcoin, not a launch still to come.' }),
      node('p', { class: 'sub', text: 'What the model does not do: it is not a price, not a prediction that a token is issued, and not a promise of an airdrop. A protocol that records no token may still have one its DefiLlama record does not carry.' }));
  }

  var dialog = node('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { view.detail = null; writeHash(); });

  function openDetail(slug) {
    var row = null;
    for (var i = 0; i < RADAR.rows.length; i++) {
      if (RADAR.rows[i].slug === slug) { row = RADAR.rows[i]; break; }
    }
    if (!row) return;
    view.detail = slug;
    writeHash();
    dialog.textContent = '';
    var steps = plan(row);
    var capital = stake(row);
    var hold = holdDays(row.age_days);
    var weeks = Math.max(1, Math.ceil(hold / 7));
    var gas = (capital >= 150 ? 8 : 4) + 2 + 2 * weeks + 2;
    var chainsText = (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain');
    var recomputed = recompute(row, RADAR.model);
    var checkText = 'Model ' + RADAR.model_version + ': the same function scores every protocol. The page recomputes this row as ' +
      money(recomputed) +
      (recomputed === row.implied_value_usd
        ? ', the same number board.json carries.'
        : ', which differs from the board: the data would be stale.') +
      ' This is an estimate, not a price. The protocol records no token; that is the record, not proof it has none.';
    dialog.appendChild(node('div', { class: 'detail-head' },
      node('div', null,
        node('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + RADAR.board_size + (row.watchlist ? ' \u00b7 Watchlist' : ' \u00b7 Early find') }),
        node('h2', { id: 'detail-title', text: row.name }),
        node('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + chainsText })),
      node('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })));
    dialog.appendChild(node('section', { class: 'detail-section' },
      node('h3', { text: 'Implied value' }),
      node('div', { class: 'equation' },
        node('div', null, node('span', { text: 'TVL' }), node('b', { class: 'num', text: money(row.tvl_usd) })),
        node('div', null, node('span', { text: 'Seven-day growth' }), node('b', { class: 'num', text: pct(row.change_7d) })),
        node('div', null, node('span', { text: 'Age with no token' }), node('b', { class: 'num', text: ageLabel(row.age_days) })),
        node('div', null, node('span', { text: 'Chains' }), node('b', { class: 'num', text: String((row.chains || []).length) })),
        node('div', null, node('span', { text: 'Growth multiplier' }), node('b', { class: 'num', text: String(row.growth_multiplier) })),
        node('div', null, node('span', { text: 'Maturity multiplier' }), node('b', { class: 'num', text: String(row.maturity_multiplier) })),
        node('div', null, node('span', { text: 'Chain multiplier' }), node('b', { class: 'num', text: String(row.chain_multiplier) })),
        node('div', { class: 'total' }, node('span', { text: 'Implied value' }), node('b', { class: 'num', text: money(row.implied_value_usd) }))),
      node('p', { class: 'sub', text: checkText })));
    dialog.appendChild(node('section', { class: 'detail-section' },
      node('h3', { text: 'Farm plan' }),
      node('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return node('li', null, node('b', { text: action }), node('span', { class: 'cost', text: tail }));
      })),
      node('div', { class: 'plan-sum' },
        node('span', null, 'Capital: ', node('b', { text: '$' + capital })),
        node('span', null, 'Gas over the hold: ', node('b', { text: 'about $' + gas })),
        node('span', null, 'Hold at least: ', node('b', { text: hold + ' days' })))));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function foot() {
    return node('footer', { class: 'foot' },
      node('span', { text: 'Source: DefiLlama protocol index, snapshot ' + RADAR.as_of + '. Model ' + RADAR.model_version + ': implied = TVL x 0.25 x growth x maturity x chain reach.' }),
      node('span', { text: 'Implied values are this radar\'s own model, never a price and never a promise. A protocol that records no token may still have one.' }));
  }

  function render() {
    // Rebuilding the board destroys the search field the user may be typing in,
    // so note whether it had focus and hand it back after the rebuild.
    var searchActive = document.activeElement && document.activeElement.id === 'q';
    var caret = searchActive ? document.activeElement.selectionStart : null;
    mount.textContent = '';
    var shell = node('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(top3());
    shell.appendChild(controls());
    shell.appendChild(view.tab === 'pre-token' ? boardTable() : liveTable());
    if (view.tab === 'pre-token') shell.appendChild(modelPanel());
    shell.appendChild(foot());
    mount.appendChild(shell);
    mount.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) mount.appendChild(dialog);
    if (searchActive) {
      var search = document.getElementById('q');
      if (search) {
        search.focus();
        try { search.setSelectionRange(caret, caret); } catch (e) { /* older browsers */ }
      }
    }
    if (view.detail) openDetail(view.detail);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
