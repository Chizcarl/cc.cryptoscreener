document.addEventListener('DOMContentLoaded', () => {
    const bodyElement = document.body;
    const sidebar = document.getElementById('settings-sidebar');
    const sidebarToggle = document.getElementById('sidebar-toggle');
    const screenerTableBody = document.getElementById('screener-table-body');
    const screenerPaginationContainer = document.getElementById('screener-pagination');
    const screenerExchangeNameSpan = document.getElementById('screener-exchange-name');
    const statusBar = document.getElementById('status-bar');
    const loadingOverlay = document.getElementById('loading-overlay');
    const exchangeSelect = document.getElementById('exchange-select');
    const applyAlphaFilterButton = document.getElementById('apply-alpha-filter');
    const refreshDataButton = document.getElementById('refresh-data');
    const tickerViewModeSelect = document.getElementById('ticker-view-mode');
    const tickerTapeContainer = document.getElementById('ticker-tape-container');
    const tickerTapeWidgetContainer = document.getElementById('tradingview-ticker-widget-container');
    const gradeModalOverlay = document.getElementById('gradeModal');
    const gradeModalItemName = document.getElementById('grade-modal-item-name');
    const gradeSelect = document.getElementById('gradeSelect');
    const confirmGradeButton = document.getElementById('confirmGradeButton');
    const gradeModalCloseButtons = gradeModalOverlay.querySelectorAll('.modal-close-button, .modal-cancel-button');
    const chartModalOverlay = document.getElementById('chartModal');
    const chartModalTitle = document.getElementById('chart-modal-title');
    const chartWidgetContainer = document.getElementById('tradingview-widget-container-dynamic');
    const infoPanelContainer = document.getElementById('pair-info-container');
    const infoPanelToggle = document.getElementById('toggle-info-panel');
    const chartModalCloseButtons = chartModalOverlay.querySelectorAll('.modal-close-button');
    const openTvSiteButton = document.getElementById('open-tv-site-button');
    const tabNav = document.getElementById('mainTabNav');
    const tabLinks = tabNav.querySelectorAll('.tab-link');
    const tabPanels = document.querySelectorAll('.tab-panel');
    const contextMenu = document.getElementById('context-menu');
    const contextAddWatchlist = document.getElementById('context-add-watchlist');
    const contextDeleteWatchlist = document.getElementById('context-delete-watchlist');
    const aboutButton = document.getElementById('about-button');
    const aboutModalOverlay = document.getElementById('aboutModal');
    const aboutModalCloseButtons = aboutModalOverlay.querySelectorAll('.modal-close-button, .modal-cancel-button');

    let fullScreenerData = [];
    let currentWatchlistData = [];
    let currentScreenerPage = 1;
    let currentWatchlistPage = 1;
    let sortColumnIndex = -1;
    let sortAscending = true;
    let contextTargetRow = null;
    let contextTargetTable = null;
    let activeModalConfirmCallback = null;
    let tradingViewChartInstance = null;
    let currentChartSymbol = '';
    let lastSortedTableId = null;
    let lastSortedHeader = null;
    let currentFilterCriteria = null; // To store applied alpha filter

    const isAuthenticated = typeof IS_AUTHENTICATED !== 'undefined' ? IS_AUTHENTICATED : false;

    let watchlistTableBody = null;
    let watchlistCountSpan = null;
    let watchlistPaginationContainer = null;
    let watchlistFilterInput = null;
    let watchlistClearFilterButton = null;
    let copyWatchlistButton = null;
    let deleteAllWatchlistButton = null;

    if (isAuthenticated) {
        watchlistTableBody = document.getElementById('watchlist-table-body');
        watchlistCountSpan = document.getElementById('watchlist-count');
        watchlistPaginationContainer = document.getElementById('watchlist-pagination');
        watchlistFilterInput = document.getElementById('watchlist-date-filter');
        watchlistClearFilterButton = document.getElementById('watchlist-clear-filter');
        copyWatchlistButton = document.getElementById('copy-watchlist');
        deleteAllWatchlistButton = document.getElementById('delete-all-watchlist');
    }

    const showLoading = (show) => loadingOverlay.classList.toggle('visible', show);
    const updateStatus = (message, isError = false) => { statusBar.textContent = message; statusBar.classList.toggle('error', isError); setTimeout(() => { if (statusBar.textContent === message) { statusBar.textContent = 'Ready'; statusBar.classList.remove('error'); } }, 5000); };
    const fetchData = async (url, options = {}) => {
        showLoading(true);
        const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
        const method = options.method?.toUpperCase() || 'GET';
        if (!options.headers) { options.headers = {}; }
        if (csrfToken && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) { options.headers['X-CSRFToken'] = csrfToken; }
        if (options.body && !options.headers['Content-Type'] && ['POST', 'PUT', 'PATCH'].includes(method)){ options.headers['Content-Type'] = 'application/json'; }

        try {
            const response = await fetch(url, options);
            if (!response.ok) { const errorData = await response.json().catch(() => ({ message: `HTTP error! ${response.status} ${response.statusText}` })); throw new Error(errorData.message || `HTTP error! ${response.status} ${response.statusText}`); }
            const contentType = response.headers.get("content-type");
            if (contentType && contentType.indexOf("application/json") !== -1) { return await response.json(); }
            else if (response.ok) { const text = await response.text(); try { return JSON.parse(text); } catch (e) { return { success: true, message: text || "Operation successful (non-JSON response)." }; } }
            else { throw new Error("Received non-JSON response"); }
        } catch (error) { console.error(`Fetch error for ${url}:`, error); updateStatus(`Error: ${error.message || 'Network request failed'}`, true); return null; }
        finally { showLoading(false); }
    };

    const handleDoubleClick = (event) => {
        const pairName = event.currentTarget.dataset.name;
        if (pairName) { navigator.clipboard.writeText(pairName).then(() => updateStatus(`Copied ${pairName}.`)).catch(err => updateStatus(`Copy failed.`, true)); }
    };

    const hideContextMenu = () => {
        if (contextMenu.style.display === 'block') {
            contextMenu.style.display = 'none'; contextTargetRow = null; contextTargetTable = null;
            document.removeEventListener('click', hideContextMenuOnClickOutside); document.removeEventListener('contextmenu', hideContextMenuOnClickOutside);
        }
    };
    const hideContextMenuOnClickOutside = (event) => { if (!contextMenu.contains(event.target)) { hideContextMenu(); } else { document.addEventListener('click', hideContextMenuOnClickOutside, { once: true }); document.addEventListener('contextmenu', hideContextMenuOnClickOutside, { once: true }); } };
    const handleContextMenu = (event) => {
        event.preventDefault(); hideContextMenu();
        contextTargetRow = event.currentTarget; contextTargetTable = contextTargetRow.closest('table').id === 'screener-table' ? 'screener' : 'watchlist';
        const showAdd = isAuthenticated && contextTargetTable === 'screener'; const showDelete = isAuthenticated && contextTargetTable === 'watchlist';
        const showOpenChart = true; const showCopyName = true;
        if (contextAddWatchlist) contextAddWatchlist.style.display = showAdd ? 'flex' : 'none';
        if (contextDeleteWatchlist) contextDeleteWatchlist.style.display = showDelete ? 'flex' : 'none';
        if (!showAdd && !showDelete && !showOpenChart && !showCopyName) return;
        const menuWidth = contextMenu.offsetWidth; const menuHeight = contextMenu.offsetHeight;
        const windowWidth = window.innerWidth; const windowHeight = window.innerHeight;
        let x = event.clientX; let y = event.clientY;
        if (x + menuWidth > windowWidth) x = windowWidth - menuWidth - 5; if (y + menuHeight > windowHeight) y = windowHeight - menuHeight - 5;
        contextMenu.style.top = `${y}px`; contextMenu.style.left = `${x}px`; contextMenu.style.display = 'block';
        document.addEventListener('click', hideContextMenuOnClickOutside, { once: true }); document.addEventListener('contextmenu', hideContextMenuOnClickOutside, { once: true });
    };

    if (sidebarToggle && sidebar) {
        sidebarToggle.addEventListener('click', () => { const isCollapsed = sidebar.classList.toggle('collapsed'); localStorage.setItem('sidebarIsCollapsed', isCollapsed); });
        if (localStorage.getItem('sidebarIsCollapsed') === 'false') { sidebar.classList.remove('collapsed'); } else { sidebar.classList.add('collapsed'); }
    }

    const renderRatingBar = (rating) => { const numRating = Number(rating); const clampedRating = isNaN(numRating) ? 0 : Math.max(0, Math.min(5, numRating)); const maxSegments = 5; let segmentsHTML = `<span class="rating-bar-container" title="Rating: ${clampedRating}/5">`; for (let i = 1; i <= maxSegments; i++) { const filledClass = i <= clampedRating ? `filled level-${clampedRating}` : ''; segmentsHTML += `<span class="rating-segment ${filledClass}"></span>`; } segmentsHTML += '</span>'; return segmentsHTML; };
    const safeSort = (data, key, ascending = true) => { return [...data].sort((a, b) => { let valA = a[key]; let valB = b[key]; const isNumA = typeof valA === 'number' && !isNaN(valA); const isNumB = typeof valB === 'number' && !isNaN(valB); if (valA === null || valA === undefined) valA = ascending ? Infinity : -Infinity; if (valB === null || valB === undefined) valB = ascending ? Infinity : -Infinity; if (isNumA && isNumB) { return ascending ? valA - valB : valB - valA; } else { const comparison = String(valA).localeCompare(String(valB), undefined, { sensitivity: 'base' }); return ascending ? comparison : -comparison; } }); };

    const updateTickerTape = (screenerData) => {
        if (!tickerTapeWidgetContainer || !tickerViewModeSelect || typeof TradingView === 'undefined' || !screenerData) { if(tickerTapeWidgetContainer) tickerTapeWidgetContainer.innerHTML = '<div class="widget-placeholder">Ticker unavailable</div>'; return; }
        const viewMode = tickerViewModeSelect.value;
        let symbols = []; const createSymbolObject = item => ({ proName: `${exchangeSelect.value}:${item.name}`, title: item.name.replace(/USDT(\.P)?$/i, '') });
        let dataForTicker = [...screenerData];
        switch(viewMode) {
            case 'top_rating': symbols = safeSort(dataForTicker, 'rating', false).slice(0, 10).map(createSymbolObject); break;
            case 'bottom_rating': symbols = safeSort(dataForTicker, 'rating', true).slice(0, 10).map(createSymbolObject); break;
            case 'top_rsi': symbols = safeSort(dataForTicker, 'RSI_original', false).slice(0, 10).map(createSymbolObject); break;
            case 'bottom_rsi': symbols = safeSort(dataForTicker, 'RSI_original', true).slice(0, 10).map(createSymbolObject); break;
            case 'all_screener': default: symbols = dataForTicker.slice(0, 20).map(createSymbolObject); break;
        }
        if (symbols.length === 0 && viewMode !== 'all_screener') { symbols = [ { "proName": `${exchangeSelect.value}:BTCUSDT`, "title": "BTC" }]; }
        tickerTapeWidgetContainer.innerHTML = '';
        const script = document.createElement('script'); script.type = 'text/javascript'; script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-ticker-tape.js'; script.async = true;
        const widgetConfig = { "container_id": tickerTapeWidgetContainer.id, "symbols": symbols, "showSymbolLogo": true, "isTransparent": true, "displayMode": "regular", "colorTheme": "dark", "locale": "en" };
        script.text = JSON.stringify(widgetConfig);
        if(document.getElementById(tickerTapeWidgetContainer.id)) { tickerTapeWidgetContainer.appendChild(script); }
    };

    const populateScreenerTable = (tbodyElement, data, columnKeys) => {
        tbodyElement.innerHTML = ''; const colCount = columnKeys.length + 1;
        if (!data || data.length === 0) { tbodyElement.innerHTML = `<tr><td colspan="${colCount}" class="placeholder">No data available.</td></tr>`; return; }
        const fragment = document.createDocumentFragment();
        data.forEach(item => {
            const row = document.createElement('tr'); row.dataset.name = item.name;
            columnKeys.forEach((key) => { const cell = row.insertCell(); if (key === 'rating') { cell.innerHTML = renderRatingBar(item[key] ?? 0); cell.classList.add('rating-cell'); } else { cell.textContent = item[key] ?? 'N/A'; } });
            const actionCell = row.insertCell(); actionCell.classList.add('table-actions');
            const addBtnDisabled = !IS_AUTHENTICATED ? 'disabled title="Login to add to watchlist"' : 'title="Add to Watchlist"';
            actionCell.innerHTML = `<button class="button-icon action-add" data-name="${item.name}" ${addBtnDisabled}><svg><use xlink:href="#icon-add-circle"></use></svg></button><button class="button-icon action-chart" title="Open Chart" data-name="${item.name}"><svg><use xlink:href="#icon-chart"></use></svg></button>`;
            row.addEventListener('dblclick', handleDoubleClick); row.addEventListener('contextmenu', handleContextMenu);
            fragment.appendChild(row);
        });
        tbodyElement.appendChild(fragment);
    };

    const populateWatchlistTable = (tbodyElement, data, columnKeys) => {
        if (!tbodyElement) return;
        tbodyElement.innerHTML = ''; const colCount = columnKeys.length + 1;
        if (!data || data.length === 0) { tbodyElement.innerHTML = `<tr><td colspan="${colCount}" class="placeholder">Watchlist empty or filter has no match.</td></tr>`; if(watchlistCountSpan) watchlistCountSpan.textContent = '0'; return; }
        const fragment = document.createDocumentFragment();
        data.forEach(item => {
            const row = document.createElement('tr'); row.dataset.name = item.name;
            columnKeys.forEach((key, index) => {
                const cell = row.insertCell(); if (index === 2) { cell.classList.add('watchlist-name-col'); }
                if (key === 'rating') { cell.innerHTML = renderRatingBar(item[key] ?? 0); cell.classList.add('rating-cell'); }
                else { cell.textContent = item[key] ?? 'N/A'; }
            });
            const actionCell = row.insertCell(); actionCell.classList.add('table-actions');
            actionCell.innerHTML = `<button class="button-icon action-chart" title="Open Chart" data-name="${item.name}"><svg><use xlink:href="#icon-chart"></use></svg></button><button class="button-icon action-copy" title="Copy Name" data-name="${item.name}"><svg><use xlink:href="#icon-copy"></use></svg></button><button class="button-icon action-delete" title="Delete" data-name="${item.name}"><svg><use xlink:href="#icon-delete"></use></svg></button>`;
            row.addEventListener('dblclick', handleDoubleClick); row.addEventListener('contextmenu', handleContextMenu);
            fragment.appendChild(row);
        });
        tbodyElement.appendChild(fragment);
        if(watchlistCountSpan) watchlistCountSpan.textContent = data.length; // Total count, not just page count
    };

    const getScreenerRowDataForWatchlist = (rowElement) => {
        const cells = rowElement.cells; if (!cells || cells.length < 8) return null;
        const ratingCell = cells[7]; const rating = ratingCell ? (ratingCell.querySelectorAll('.rating-segment.filled')?.length ?? 0) : 0;
        return [ cells[0].textContent, cells[1].textContent, cells[2].textContent, cells[3].textContent, cells[4].textContent, cells[5].textContent, cells[6].textContent, rating ];
    };

    const sortTable = (tableId, columnIndex) => {
        const table = document.getElementById(tableId); if (!table) return;
        const tbody = table.tBodies[0]; if (!tbody) return;
        const headerCells = table.tHead.rows[0].cells;
        let rows = Array.from(tbody.rows);
        if (tableId === 'watchlist-table') { rows = rows.filter(row => !row.querySelector('.watchlist-date-header')); }
        if (!rows.length || !headerCells[columnIndex] || headerCells[columnIndex].classList.contains('actions-header')) return;
        const sortType = headerCells[columnIndex].dataset.sort || 'string';
        if (columnIndex === sortColumnIndex && tableId === lastSortedTableId) { sortAscending = !sortAscending; }
        else { sortAscending = true; if (sortColumnIndex !== -1 && lastSortedHeader) { const prevIndicator = lastSortedHeader.querySelector('.sort-indicator'); if(prevIndicator) prevIndicator.className = 'sort-indicator'; } sortColumnIndex = columnIndex; }
        lastSortedTableId = tableId; lastSortedHeader = headerCells[columnIndex];
        Array.from(headerCells).forEach((th, index) => { const indicator = th.querySelector('.sort-indicator'); if (indicator) { indicator.className = `sort-indicator ${index === columnIndex ? (sortAscending ? 'asc' : 'desc') : ''}`; }});
        rows.sort((a, b) => {
            let valA, valB; const ratingColIndexScreener = 7; const ratingColIndexWatchlist = 10;
            const isRatingColumn = (tableId === 'screener-table' && columnIndex === ratingColIndexScreener) || (tableId === 'watchlist-table' && columnIndex === ratingColIndexWatchlist);
            if (isRatingColumn) { valA = a.cells[columnIndex]?.querySelectorAll('.rating-segment.filled').length || 0; valB = b.cells[columnIndex]?.querySelectorAll('.rating-segment.filled').length || 0; }
            else { valA = a.cells[columnIndex]?.textContent.trim() || ''; valB = b.cells[columnIndex]?.textContent.trim() || ''; }
            const isNaA = valA === 'N/A' || valA === ''; const isNaB = valB === 'N/A' || valB === '';
            if (isNaA && isNaB) return 0; if (isNaA) return sortAscending ? 1 : -1; if (isNaB) return sortAscending ? -1 : 1;
            let comparison = 0;
            switch (sortType) {
                case 'numeric': const numA = isRatingColumn ? valA : parseFloat(valA.replace(/[^0-9.-]+/g, '')); const numB = isRatingColumn ? valB : parseFloat(valB.replace(/[^0-9.-]+/g, '')); if (!isNaN(numA) && !isNaN(numB)) { comparison = numA - numB; } else { comparison = String(valA).localeCompare(String(valB)); } break;
                case 'date': try { let dtA, dtB; if (tableId === 'watchlist-table' && columnIndex <= 1) { dtA = new Date(`${a.cells[0]?.textContent}T${a.cells[1]?.textContent}`); dtB = new Date(`${b.cells[0]?.textContent}T${b.cells[1]?.textContent}`); } else { dtA = new Date(valA); dtB = new Date(valB); } if (!isNaN(dtA) && !isNaN(dtB)) { comparison = dtA - dtB; } else { comparison = String(valA).localeCompare(String(valB)); }} catch(e) { comparison = String(valA).localeCompare(String(valB)); } break;
                case 'string': default: comparison = String(valA).localeCompare(String(valB), undefined, { sensitivity: 'base' }); break;
            } return sortAscending ? comparison : -comparison;
        });
        const fragment = document.createDocumentFragment(); rows.forEach(row => fragment.appendChild(row));
        while(tbody.firstChild) { tbody.removeChild(tbody.firstChild); } tbody.appendChild(fragment);
     };
     document.querySelectorAll('.data-table thead th').forEach(th => {
         th.addEventListener('click', () => { const tableId = th.closest('table').id; const columnIndex = parseInt(th.dataset.columnIndex); if (!isNaN(columnIndex) && columnIndex >= 0 && !th.classList.contains('actions-header')) { sortTable(tableId, columnIndex); } else { if (!th.classList.contains('actions-header')) console.warn("Invalid col index or non-sortable header:", th.dataset.columnIndex); } });
      });

    const showModal = (modalOverlayElement) => modalOverlayElement.classList.add('visible');
    const hideModal = (modalOverlayElement) => modalOverlayElement.classList.remove('visible');
    gradeModalCloseButtons.forEach(button => button.addEventListener('click', () => hideModal(gradeModalOverlay)));
    gradeModalOverlay.addEventListener('click', (event) => { if (event.target === gradeModalOverlay) hideModal(gradeModalOverlay); });
    confirmGradeButton.addEventListener('click', () => { if (activeModalConfirmCallback) activeModalConfirmCallback(); hideModal(gradeModalOverlay); activeModalConfirmCallback = null; });
    chartModalCloseButtons.forEach(button => button.addEventListener('click', () => hideModal(chartModalOverlay)));
    chartModalOverlay.addEventListener('click', (event) => { if (event.target === chartModalOverlay) hideModal(chartModalOverlay); });
    aboutModalCloseButtons.forEach(button => button.addEventListener('click', () => hideModal(aboutModalOverlay)));
    aboutModalOverlay.addEventListener('click', (event) => { if (event.target === aboutModalOverlay) hideModal(aboutModalOverlay); });
    if (infoPanelToggle && infoPanelContainer) { infoPanelToggle.addEventListener('click', () => { const isCollapsed = infoPanelContainer.classList.toggle('collapsed'); localStorage.setItem('infoPanelCollapsed', isCollapsed); }); if (localStorage.getItem('infoPanelCollapsed') === 'true') { infoPanelContainer.classList.add('collapsed'); } }
    if (aboutButton) { aboutButton.addEventListener('click', () => showModal(aboutModalOverlay)); }

    const formatLabel = (key) => { let label = key.replace(/\|240/g, ' (4h)').replace(/[._]/g, ' ').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/([a-z\d])([A-Z])/g, '$1 $2'); label = label.replace(/(^|\s)\S/g, l => l.toUpperCase()); label = label.replace('Rsi', 'RSI').replace('Ema', 'EMA').replace('Atr', 'ATR').replace('Atrp', 'ATRP').replace('Vwap', 'VWAP').replace('Vwma', 'VWMA').replace(/(\d+)d Calc/g, '$1d').replace('Price 52 Week', '52 Week'); return label; };
    const displayPairInfo = (container, data) => {
        if (!container || !data) { if(container) container.innerHTML = '<div class="widget-placeholder">Info N/A</div>'; return; }
        const infoGroups = { "Volatility / Volume": ['Volatility.D', 'Volatility.W', 'Volatility.M', 'ATR', 'ATRP', 'volume', 'volume_change', 'Value.Traded', 'average_volume_10d_calc', 'average_volume_30d_calc', 'average_volume_60d_calc', 'average_volume_90d_calc', 'VWAP', 'VWMA'], "Performance": ['Perf.5D','Perf.W', 'Perf.1M', 'Perf.3M', 'Perf.6M', 'Perf.YTD', 'Perf.Y', 'Perf.All', 'change|240', 'change'], "Levels": ['High.5D','Low.5D', 'High.1M', 'Low.1M', 'High.3M', 'Low.3M', 'High.6M', 'Low.6M', 'price_52_week_high', 'price_52_week_low', 'High.All', 'Low.All'] };
        let html = '';
        for (const groupName in infoGroups) {
            let groupHtml = ''; infoGroups[groupName].forEach(key => { if (data.hasOwnProperty(key)) { const value = data[key] ?? 'N/A'; const label = formatLabel(key); groupHtml += `<div class="info-item"><span>${label}:</span><span>${value}</span></div>`; } });
            if (groupHtml) { html += `<div class="info-group"><h4>${groupName}</h4>${groupHtml}</div>`; }
        }
        container.innerHTML = html || '<div class="widget-placeholder">No detailed info available.</div>';
    };

    const showChartModal = (pairName) => {
        if (!pairName) return;
        if (typeof TradingView === 'undefined' || !TradingView.widget) {
            updateStatus("Error: Chart library.", true);
            return;
        }

        chartModalTitle.textContent = `${pairName} Chart & Info`;
        chartWidgetContainer.innerHTML = '<div class="widget-placeholder">Loading Chart...</div>';
        if(infoPanelContainer) infoPanelContainer.innerHTML = '<div class="widget-placeholder">Loading Info...</div>';

        const currentExchange = exchangeSelect ? exchangeSelect.value : 'BYBIT';
        currentChartSymbol = `${currentExchange}:${pairName}`;

        const pairData = [...fullScreenerData, ...currentWatchlistData].find(item => item.name === pairName);

        try {
            if (tradingViewChartInstance && typeof tradingViewChartInstance.remove === 'function') {
                 const dynamicContainer = document.getElementById("tradingview-widget-container-dynamic");
                 if (dynamicContainer && dynamicContainer.hasChildNodes()) {
                    try {
                        console.log("Attempting to remove existing chart instance.");
                        tradingViewChartInstance.remove();
                        console.log("Chart instance removed.");
                    } catch (e) {
                        console.warn("Error removing chart instance via remove():", e);
                        console.warn("Clearing container HTML as fallback.");
                        if (dynamicContainer) dynamicContainer.innerHTML = '';
                    }
                 } else {
                    console.log("Chart container already empty or not found, skipping remove().");
                 }
                 tradingViewChartInstance = null;
            } else {
                 console.log("No valid chart instance to remove.");
                 const dynamicContainer = document.getElementById("tradingview-widget-container-dynamic");
                 if (dynamicContainer) dynamicContainer.innerHTML = '';
            }

             const dynamicContainer = document.getElementById("tradingview-widget-container-dynamic");
             if(dynamicContainer) dynamicContainer.innerHTML = '';
             else {
                console.error("Dynamic chart container not found!");
                updateStatus("Chart container error.", true);
                return;
             }


            tradingViewChartInstance = new TradingView.widget({
                "container_id": "tradingview-widget-container-dynamic",
                "autosize": true,
                "symbol": currentChartSymbol,
                "interval": "240",
                "timezone": "Etc/UTC",
                "theme": "dark",
                "style": "1",
                "locale": "en",
                "enable_publishing": false,
                "hide_side_toolbar": true,
                "hide_legend": true,
                "allow_symbol_change": true,
                "gridColor": "rgba(0, 0, 0, 0.06)",
                "save_image": false,
                "studies": [
                    { "id": "MAExp@tv-basicstudies", "inputs": { "length": 100 } },
                    { "id": "RSI@tv-basicstudies", "inputs": { "length": 14 } }
                ],
                "support_host": "https://www.tradingview.com"
            });
             console.log("New chart instance created for:", currentChartSymbol);

        } catch (error) {
            console.error("Chart Widget creation/handling error:", error);
            updateStatus("Error loading chart.", true);
            chartWidgetContainer.innerHTML = '<div class="widget-placeholder">Error loading chart.</div>';
            tradingViewChartInstance = null;
        }

        displayPairInfo(infoPanelContainer, pairData);
        if (openTvSiteButton) openTvSiteButton.href = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(currentChartSymbol)}`;
        if (localStorage.getItem('infoPanelCollapsed') === 'true') { infoPanelContainer?.classList.add('collapsed'); } else { infoPanelContainer?.classList.remove('collapsed'); }
        showModal(chartModalOverlay);
    };

    const renderPagination = (containerElement, paginationData, loadFunction) => {
        if (!containerElement || !paginationData || paginationData.total_pages <= 1) {
            if(containerElement) containerElement.innerHTML = '';
            return;
        }
        const { current_page, total_pages, has_prev, has_next } = paginationData;
        let html = '<nav class="pagination" aria-label="Table navigation"><ul class="pagination-list">';
        html += `<li class="pagination-item"><button class="button button-secondary compact pagination-prev" ${!has_prev ? 'disabled' : ''} data-page="${current_page - 1}">Previous</button></li>`;

        let startPage = Math.max(1, current_page - 2);
        let endPage = Math.min(total_pages, current_page + 2);
        if (current_page <= 3) endPage = Math.min(total_pages, 5);
        if (current_page >= total_pages - 2) startPage = Math.max(1, total_pages - 4);

        if (startPage > 1) {
            html += `<li class="pagination-item"><button class="button button-secondary compact" data-page="1">1</button></li>`;
            if (startPage > 2) html += `<li class="pagination-item pagination-ellipsis"><span>...</span></li>`;
        }

        for (let i = startPage; i <= endPage; i++) {
            html += `<li class="pagination-item"><button class="button ${i === current_page ? 'button-primary' : 'button-secondary'} compact" ${i === current_page ? 'disabled' : ''} data-page="${i}">${i}</button></li>`;
        }

        if (endPage < total_pages) {
            if (endPage < total_pages - 1) html += `<li class="pagination-item pagination-ellipsis"><span>...</span></li>`;
            html += `<li class="pagination-item"><button class="button button-secondary compact" data-page="${total_pages}">${total_pages}</button></li>`;
        }

        html += `<li class="pagination-item"><button class="button button-secondary compact pagination-next" ${!has_next ? 'disabled' : ''} data-page="${current_page + 1}">Next</button></li>`;
        html += '</ul></nav>';
        containerElement.innerHTML = html;

        containerElement.querySelectorAll('.pagination-list button[data-page]').forEach(button => {
            if (!button.disabled) {
                button.addEventListener('click', (event) => {
                    const page = parseInt(event.target.dataset.page);
                    loadFunction(page);
                });
            }
        });
    };

    tabNav.addEventListener('click', (event) => {
        const clickedTab = event.target.closest('.tab-link');
        if (!clickedTab || clickedTab.classList.contains('active')) return;
        if (clickedTab.dataset.tabTarget === '#watchlist-tab-pane' && !IS_AUTHENTICATED) { window.location.href = '/login'; return; }
        tabLinks.forEach(link => link.classList.remove('active'));
        tabPanels.forEach(panel => panel.classList.remove('active'));
        clickedTab.classList.add('active');
        const targetPanelId = clickedTab.dataset.tabTarget;
        const targetPanel = document.querySelector(targetPanelId);
        if (targetPanel) targetPanel.classList.add('active');
    });
    screenerTableBody.addEventListener('click', async (event) => {
        const addButton = event.target.closest('.action-add:not([disabled])');
        const chartButton = event.target.closest('.action-chart');
        const targetRow = event.target.closest('tr'); if (!targetRow) return;
        if (addButton) {
             const pairName = addButton.dataset.name; const itemData = getScreenerRowDataForWatchlist(targetRow);
             if (itemData && pairName) {
                 gradeModalItemName.textContent = pairName;
                 activeModalConfirmCallback = async () => {
                     const grade = gradeSelect.value;
                     const result = await fetchData('/watchlist/add', { method: 'POST', body: JSON.stringify({ itemData: itemData, grade: grade }) });
                     if (result?.success) { updateStatus(result.message); if (IS_AUTHENTICATED) loadWatchlist(); }
                     else { updateStatus(result?.message || 'Add failed.', true); }
                 };
                 showModal(gradeModalOverlay);
             }
             else { updateStatus("Could not get data.", true); }
        }
        else if (chartButton) { const pairName = chartButton.dataset.name; if (pairName) { showChartModal(pairName); } }
    });
    contextMenu.addEventListener('click', async (event) => {
        const targetLi = event.target.closest('li'); if (!targetLi || !contextTargetRow) return; const action = targetLi.dataset.action; const pairName = contextTargetRow.dataset.name; if (!action || !pairName) return; hideContextMenu();
        switch (action) {
            case 'open-tv': showChartModal(pairName); break;
            case 'add-watchlist':
                if (!IS_AUTHENTICATED) { updateStatus("Please log in to add items.", "warning"); return; }
                const itemData = getScreenerRowDataForWatchlist(contextTargetRow);
                if (itemData) {
                    gradeModalItemName.textContent = pairName;
                    activeModalConfirmCallback = async () => {
                        const grade = gradeSelect.value; const result = await fetchData('/watchlist/add', { method: 'POST', body: JSON.stringify({ itemData: itemData, grade: grade }) });
                        if (result?.success) { updateStatus(result.message); if (IS_AUTHENTICATED) loadWatchlist(); } else { updateStatus(result?.message || 'Add failed.', true); }
                    }; showModal(gradeModalOverlay);
                } else { updateStatus("Could not get data.", true); }
                break;
            case 'copy-name': navigator.clipboard.writeText(pairName).then(() => updateStatus(`Copied ${pairName}.`)).catch(err => updateStatus(`Copy failed.`, true)); break;
            case 'delete-watchlist':
                if (!IS_AUTHENTICATED) { updateStatus("Please log in to manage watchlist.", "warning"); return; }
                if (confirm(`Delete ${pairName}?`)) { const result = await fetchData('/watchlist/delete', { method: 'POST', body: JSON.stringify({ name: pairName }) }); if (result?.success) { updateStatus(result.message); if (IS_AUTHENTICATED) loadWatchlist(); } else { updateStatus(result?.message || 'Delete failed.', true); } }
                break;
        }
     });

    const applyAlphaFilter = async (page = 1) => {
         currentFilterCriteria = { ema4hr: document.getElementById('alpha-ema-4hr').value, rsi4hr: document.getElementById('alpha-rsi-4hr').value, emaDaily: document.getElementById('alpha-ema-daily').value, rsiDaily: document.getElementById('alpha-rsi-daily').value };
         const result = await fetchData(`/filter/alpha?page=${page}`, { method: 'POST', body: JSON.stringify(currentFilterCriteria) });
         const screenerColumns = ['name', 'close|240', 'volume', 'RSI|240', 'RSI', 'EMA_Class_4hr', 'EMA_Class_Daily', 'rating'];
         if (result?.data && result?.pagination) {
             populateScreenerTable(screenerTableBody, result.data, screenerColumns);
             renderPagination(screenerPaginationContainer, result.pagination, applyAlphaFilter); // Pass the filter function itself for pagination clicks
             fullScreenerData = result.data; // Update for ticker tape - maybe fetch all unfiltered for ticker? This is complex. Let's base ticker on current view for now.
             updateTickerTape(result.data);
             currentScreenerPage = result.pagination.current_page;
             if (screenerExchangeNameSpan) screenerExchangeNameSpan.textContent = result.exchange || 'N/A';
             const message = `Filter applied (${result.pagination.total_items} results). Page ${currentScreenerPage} of ${result.pagination.total_pages}.`;
             updateStatus(message, result.data.length === 0);
         } else {
             populateScreenerTable(screenerTableBody, [], screenerColumns);
             renderPagination(screenerPaginationContainer, null, loadInitialScreenerData);
             fullScreenerData = [];
             updateTickerTape([]);
             updateStatus(result?.error || 'Filter failed.', true);
         }
     };
    applyAlphaFilterButton.addEventListener('click', () => applyAlphaFilter(1)); // Start filter on page 1

    if (tickerViewModeSelect) { tickerViewModeSelect.addEventListener('change', () => updateTickerTape(fullScreenerData)); } // Pass current data

    refreshDataButton.addEventListener('click', async () => {
        if (!IS_AUTHENTICATED) { updateStatus("Please log in to refresh data.", "warning"); return; }
        const currentExchange = exchangeSelect ? exchangeSelect.value : 'BYBIT';
        updateStatus(`Refreshing data for ${currentExchange}...`);
        const result = await fetchData('/data/refresh', { method: 'POST' });
        if (result) {
            updateStatus(result.message + " Please wait...", false);
            // Reload data after a delay, respecting filter if applied
            setTimeout(() => {
                if (currentFilterCriteria) {
                    applyAlphaFilter(currentScreenerPage);
                } else {
                    loadInitialScreenerData(currentScreenerPage);
                }
            }, 15000); // 15 second delay
        } else { updateStatus("Refresh failed.", true); }
    });

    if (exchangeSelect) {
        exchangeSelect.addEventListener('change', async (event) => {
            const newExchange = event.target.value;
            updateStatus(`Setting exchange to ${newExchange} and refreshing...`);
            const result = await fetchData('/settings/exchange', {
                method: 'POST',
                body: JSON.stringify({ exchange: newExchange })
            });
            if (result?.success) {
                updateStatus(result.message, false);
                 // Reload data after a delay, resetting filter and page
                setTimeout(() => {
                    currentFilterCriteria = null; // Reset filter on exchange change
                    loadInitialScreenerData(1);
                    if (IS_AUTHENTICATED) loadWatchlist(1); // Reload watchlist too
                }, 15000);
            } else {
                updateStatus(result?.message || 'Failed to set exchange.', true);
                // Revert dropdown if failed?
                // event.target.value = previousValue; // Need to store previous value
            }
        });
    }

    if (IS_AUTHENTICATED) {
        const applyWatchlistFilter = () => { loadWatchlist(1); }; // Reload from page 1 when date filter changes
        if (watchlistFilterInput) { watchlistFilterInput.addEventListener('change', applyWatchlistFilter); }
        if (watchlistClearFilterButton) { watchlistClearFilterButton.addEventListener('click', () => { if(watchlistFilterInput) watchlistFilterInput.value = ''; applyWatchlistFilter(); }); }
        if(copyWatchlistButton){ copyWatchlistButton.addEventListener('click', async () => { const result = await fetchData('/watchlist/copy_data'); if (result?.success && typeof result.text === 'string') { navigator.clipboard.writeText(result.text).then(() => updateStatus('Copied.')).catch(err => updateStatus('Copy failed.', true)); } else { updateStatus(result?.message || 'Copy failed.', true); } }); }
        if(deleteAllWatchlistButton) { deleteAllWatchlistButton.addEventListener('click', async () => { if (confirm('Delete ALL watchlist items?')) { const result = await fetchData('/watchlist/delete_all', { method: 'POST' }); if (result?.success) { updateStatus(result.message); if (IS_AUTHENTICATED) loadWatchlist(1); } else { updateStatus(result?.message || 'Delete failed.', true); } } }); }
        if (watchlistTableBody) {
            watchlistTableBody.addEventListener('click', async (event) => {
                if (!IS_AUTHENTICATED) return;
                const chartButton = event.target.closest('.action-chart'); const copyButton = event.target.closest('.action-copy'); const deleteButton = event.target.closest('.action-delete'); const targetRow = event.target.closest('tr');
                if (chartButton && targetRow) { const pairName = chartButton.dataset.name; if (pairName) { showChartModal(pairName); } }
                else if (copyButton && targetRow) { const pairName = copyButton.dataset.name; if (pairName) { navigator.clipboard.writeText(pairName).then(() => updateStatus(`Copied ${pairName}.`)).catch(err => updateStatus(`Copy failed.`, true)); } }
                else if (deleteButton && targetRow) { const pairName = deleteButton.dataset.name; if (pairName) { if (confirm(`Delete ${pairName}?`)) { const result = await fetchData('/watchlist/delete', { method: 'POST', body: JSON.stringify({ name: pairName }) }); if (result?.success) { updateStatus(result.message); if (IS_AUTHENTICATED) loadWatchlist(currentWatchlistPage); } else { updateStatus(result?.message || 'Delete failed.', true); } } } else { console.error("Could not find data-name on delete button:", deleteButton); updateStatus("Could not identify item to delete.", true); } }
            });
        }
    }

    const loadWatchlist = async (page = 1) => {
        if (!IS_AUTHENTICATED || !watchlistTableBody || !watchlistPaginationContainer) { if (watchlistCountSpan) watchlistCountSpan.textContent = '0'; return; }
        currentWatchlistPage = page;
        const result = await fetchData(`/watchlist?page=${page}`);
        const watchlistColumns = ["date_added", "time_added", "name", "price", "volume", "rsi_4hr", "rsi_d", "ema_4hr", "ema_d", "grade", "rating"];
        if (result?.data && result?.pagination) {
             currentWatchlistData = result.data; // Store only current page data
             populateWatchlistTable(watchlistTableBody, currentWatchlistData, watchlistColumns);
             renderPagination(watchlistPaginationContainer, result.pagination, loadWatchlist);
             if (watchlistCountSpan) watchlistCountSpan.textContent = result.pagination.total_items;
             // Apply date filter client-side (if needed, but backend filtering is better)
             // Or better: modify backend to accept date filter in query params
        } else {
             currentWatchlistData = [];
             populateWatchlistTable(watchlistTableBody, [], watchlistColumns);
             renderPagination(watchlistPaginationContainer, null, loadWatchlist);
             if (watchlistCountSpan) watchlistCountSpan.textContent = '0';
             updateStatus(result?.error || 'Failed to load watchlist', true);
        }
     };
    const loadInitialScreenerData = async (page = 1) => {
         currentScreenerPage = page;
         currentFilterCriteria = null; // Reset filter when doing initial load
         const result = await fetchData(`/data/screener?page=${page}`);
         const screenerColumns = ['name', 'close|240', 'volume', 'RSI|240', 'RSI', 'EMA_Class_4hr', 'EMA_Class_Daily', 'rating'];
         if (result?.data && result?.pagination) {
             populateScreenerTable(screenerTableBody, result.data, screenerColumns);
             renderPagination(screenerPaginationContainer, result.pagination, loadInitialScreenerData);
             fullScreenerData = result.data; // Ticker tape uses current page data
             updateTickerTape(result.data);
             if (screenerExchangeNameSpan) screenerExchangeNameSpan.textContent = result.exchange || 'N/A';
             updateStatus(`Screener data loaded for ${result.exchange}. Page ${page} of ${result.pagination.total_pages}.`);
        } else {
             populateScreenerTable(screenerTableBody, [], screenerColumns);
             renderPagination(screenerPaginationContainer, null, loadInitialScreenerData);
             fullScreenerData = [];
             updateTickerTape([]);
             if (screenerExchangeNameSpan) screenerExchangeNameSpan.textContent = result?.exchange || 'N/A';
             updateStatus(result?.error || 'Load failed.', true);
         }
     };

    loadInitialScreenerData(1);
    loadWatchlist(1);
});