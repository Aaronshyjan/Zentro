document.addEventListener('DOMContentLoaded', () => {
    
    // --- Validation Logic State & Helpers ---
    let PHONE_RULES = {
      'SG': { length: 8, prefix: '^+?65', code: '65' },
      'IN': { length: 10, prefix: '^+?91', code: '91' },
      'US': { length: 10, prefix: '^+?1', code: '1' },
      'GB': { length: 10, prefix: '^+?44', code: '44' },
      'DEFAULT': { minLength: 7, maxLength: 15 }
    };
    
    const EXPECTED_FIELDS = [
      'order_id', 'customer_name', 'email', 'phone', 
      'country_code', 'order_date', 'amount', 
      'payment_mode', 'product_id', 'product_name', 'quantity'
    ];
    
    let validRows = [];
    let invalidRows = [];
    let totalProcessed = 0;
    let stats = { count: 0, mean: 0, M2: 0, variance: 0, stdDev: 0 };
    let seenRecords = new Set();
    let fieldMappingCache = null;
    let duplicateCount = 0;
    let startTime = 0;
    let charts = {};
    let latestValidationResult = null;
    let currentErrorFilter = 'all';
    
    function levenshtein(a, b) {
      const matrix = Array.from({ length: b.length + 1 }, (_, i) => [i]);
      matrix[0] = Array.from({ length: a.length + 1 }, (_, j) => j);
      for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
          if (b.charAt(i - 1) === a.charAt(j - 1)) matrix[i][j] = matrix[i - 1][j - 1];
          else matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1));
        }
      }
      return matrix[b.length][a.length];
    }
    
    function mapSchema(fields) {
      const mapping = {};
      for (const field of fields) {
        let bestMatch = field;
        let minDistance = Infinity;
        for (const expected of EXPECTED_FIELDS) {
          if (expected === field) { bestMatch = expected; break; }
          const dist = levenshtein(field.toLowerCase(), expected.toLowerCase());
          if (dist <= 3 && dist < minDistance) { minDistance = dist; bestMatch = expected; }
        }
        mapping[field] = bestMatch;
      }
      return mapping;
    }
    
    function autoCorrectRow(row) {
      if (!row.country_code && row.phone) {
        const cleanedPhone = row.phone.replace(/\D/g, '');
        for (const [code, rules] of Object.entries(PHONE_RULES)) {
          if (rules.code && cleanedPhone.startsWith(rules.code)) {
            row.country_code = code; break;
          }
        }
      }
    }
    
    function isValidDate(dateString) {
      const regex = /^\d{4}-\d{2}-\d{2}$|^\d{2}\/\d{2}\/\d{4}$/;
      if (!regex.test(dateString)) return false;
      const d = new Date(dateString);
      return d instanceof Date && !isNaN(d);
    }
    
    function isValidEmail(email) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }
    
    function validateRow(row) {
      let errors = [];
      autoCorrectRow(row);
      
      if (!row.order_id || row.order_id.trim() === '') errors.push('missing_order_id');
      if (!row.product_id || row.product_id.trim() === '') errors.push('missing_product_id');
      if (!row.payment_mode || row.payment_mode.trim() === '') errors.push('missing_payment_mode');
      if (row.email && !isValidEmail(row.email)) errors.push('invalid_email');
      
      const hash = `${(row.email||'').toLowerCase().trim()}_${(row.customer_name||'').toLowerCase().replace(/[^a-z]/g, '')}`;
      if (hash !== '_') {
        if (seenRecords.has(hash)) { errors.push('duplicate_record'); duplicateCount++; }
        else seenRecords.add(hash);
      }
      
      if (row.amount !== undefined) {
        const amt = parseFloat(row.amount);
        if (isNaN(amt)) errors.push('invalid_amount');
        else {
          stats.count++;
          const delta = amt - stats.mean;
          stats.mean += delta / stats.count;
          stats.M2 += delta * (amt - stats.mean);
          stats.stdDev = Math.sqrt(stats.M2 / stats.count);
          if (stats.count > 100 && Math.abs(amt - stats.mean) > (3 * stats.stdDev)) errors.push('anomaly_unusual_amount');
        }
      }
      
      if (row.order_date && !isValidDate(row.order_date)) errors.push('invalid_date');
      
      if (row.phone && row.country_code) {
        const cleaned = row.phone.replace(/\D/g, '');
        const rules = PHONE_RULES[row.country_code.toUpperCase()] || PHONE_RULES['DEFAULT'];
        if (rules.length && cleaned.length !== rules.length) errors.push(`invalid_phone_length_for_${row.country_code}`);
        else if (rules.minLength && (cleaned.length < rules.minLength || cleaned.length > rules.maxLength)) errors.push('invalid_phone_length');
      }
    
      return errors;
    }

    // --- 1. Theme Toggling ---
    const themeToggleBtn = document.getElementById('theme-toggle');
    const htmlElement = document.documentElement;

    themeToggleBtn.addEventListener('click', () => {
        htmlElement.classList.toggle('dark-theme');
        const isDark = htmlElement.classList.contains('dark-theme');
        themeToggleBtn.innerHTML = isDark ? '<i class="fa-solid fa-sun"></i>' : '<i class="fa-solid fa-moon"></i>';
        updateChartsTheme(isDark);
    });

    // --- 2. File Upload Handling ---
    const dropArea = document.getElementById('dropArea');
    const fileInput = document.getElementById('fileInput');
    const uploadProgressContainer = document.getElementById('uploadProgressContainer');
    const uploadProgressBar = document.getElementById('uploadProgressBar');
    const uploadPercent = document.getElementById('uploadPercent');
    const uploadFileName = document.getElementById('uploadFileName');

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropArea.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    ['dragenter', 'dragover'].forEach(eventName => {
        dropArea.addEventListener(eventName, () => dropArea.classList.add('dragover'), false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropArea.addEventListener(eventName, () => dropArea.classList.remove('dragover'), false);
    });

    dropArea.addEventListener('drop', handleDrop, false);
    fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

    function handleDrop(e) {
        let dt = e.dataTransfer;
        let files = dt.files;
        handleFiles(files);
    }

    function handleFiles(files) {
        if (files.length > 0) {
            const file = files[0];
            processFile(file);
        }
    }

    let currentUploadedFilename = '';
    // Determine API Base URL
    // If we're running locally, talk to the local Flask server.
    // If we're on Vercel, talk to /api (which vercel.json rewrites to Render)
    const isLocalFrontend = ['localhost', '127.0.0.1'].includes(window.location.hostname);
    const API_BASE = isLocalFrontend ? 'http://127.0.0.1:5000/api' : '/api';

    function processFile(file) {
        dropArea.classList.add('hidden');
        uploadProgressContainer.classList.remove('hidden');
        
        const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
        uploadFileName.textContent = `${file.name} (${sizeMB > 0 ? sizeMB : 1.2}MB)`;
        
        uploadProgressBar.style.width = `50%`;
        uploadPercent.textContent = `50%`;
        
        const formData = new FormData();
        formData.append('file', file);
        
        fetch(`${API_BASE}/upload`, {
            method: 'POST',
            body: formData
        })
        .then(res => res.json())
        .then(data => {
            uploadProgressBar.style.width = `100%`;
            uploadPercent.textContent = `100%`;
            
            if (data.error) {
                showToast('UPLOAD_FAILED', data.error);
                return;
            }
            
            currentUploadedFilename = data.filename;
            document.getElementById('stat-files').textContent = "1";
            showToast('UPLOAD_OK', 'File ready for validation.');
            
            // Populate preview
            const previewThead = document.querySelector('#previewTable thead tr');
            const previewTbody = document.querySelector('#previewTable tbody');
            previewThead.innerHTML = data.headers.map(h => `<th>${h}</th>`).join('');
            previewTbody.innerHTML = data.preview.map(row => {
                return `<tr>${data.headers.map(h => `<td>${row[h] || ''}</td>`).join('')}</tr>`;
            }).join('');
            
            setTimeout(() => {
                uploadProgressContainer.classList.add('hidden');
                dropArea.classList.remove('hidden');
                uploadProgressBar.style.width = '0%';
            }, 3000);
        })
        .catch(err => {
            showToast('UPLOAD_ERR', `Could not connect to backend: ${err.message}`);
            uploadProgressContainer.classList.add('hidden');
            dropArea.classList.remove('hidden');
        });
    }

    // Backend validation logic
    const btnValidateData = document.getElementById('btnValidateData');
    if (btnValidateData) {
        btnValidateData.addEventListener('click', () => {
            if (!currentUploadedFilename) {
                showToast('NO_FILE', 'Upload a file first.');
                return;
            }
            btnValidateData.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> VALIDATING...';
            btnValidateData.disabled = true;
            
            // Start Validation Animation
            const valProgressBar = document.getElementById('valProgressBar');
            const stepIcons = document.querySelectorAll('#valStepper .icon-status');
            const stepTexts = document.querySelectorAll('#valStepper .text-status');
            const stepRows = document.querySelectorAll('#valStepper .step');
            
            if (valProgressBar) valProgressBar.style.width = '30%';
            stepRows.forEach(row => { row.classList.remove('text-muted'); row.classList.add('accent-text'); });
            stepIcons.forEach(icon => { icon.className = 'fa-solid fa-spinner fa-spin mr-2 icon-status'; });
            stepTexts.forEach(txt => { txt.textContent = 'PROCESSING...'; txt.className = 'mono text-status accent-text'; });
            
            fetch(`${API_BASE}/validate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: currentUploadedFilename })
            })
            .then(res => res.json())
            .then(data => {
                btnValidateData.innerHTML = '[ VALIDATE_DATA ]';
                btnValidateData.disabled = false;
                
                if (data.error) {
                    showToast('VAL_ERR', data.error);
                    // Reset Animation
                    if (valProgressBar) valProgressBar.style.width = '0%';
                    stepRows.forEach(row => { row.classList.remove('accent-text'); row.classList.add('text-muted'); });
                    stepIcons.forEach(icon => { icon.className = 'fa-regular fa-circle mr-2 icon-status'; });
                    stepTexts.forEach(txt => { txt.textContent = 'WAITING'; txt.className = 'mono text-status'; });
                    return;
                }
                
                // Finish Validation Animation
                if (valProgressBar) valProgressBar.style.width = '100%';
                stepRows.forEach(row => { row.classList.remove('accent-text'); row.classList.remove('text-muted'); });
                stepIcons.forEach(icon => { icon.className = 'fa-solid fa-circle-check text-success mr-2 icon-status'; });
                stepTexts.forEach(txt => { txt.textContent = 'DONE'; txt.className = 'mono text-status text-success'; });
                
                updateDashboard(data);
                latestValidationResult = data;
                updateAiInsights(data);
                showToast('VAL_OK', 'Validation complete.');
            })
            .catch(err => {
                btnValidateData.innerHTML = '[ VALIDATE_DATA ]';
                btnValidateData.disabled = false;
                showToast('VAL_ERR', `Validation display error: ${err.message}`);
                // Reset Animation
                if (valProgressBar) valProgressBar.style.width = '0%';
                stepRows.forEach(row => { row.classList.remove('accent-text'); row.classList.add('text-muted'); });
                stepIcons.forEach(icon => { icon.className = 'fa-regular fa-circle mr-2 icon-status'; });
                stepTexts.forEach(txt => { txt.textContent = 'WAITING'; txt.className = 'mono text-status'; });
            });

        });
    }

    function updateDashboard(data) {
        // 1. Update Metrics
        document.getElementById('stat-total').textContent = data.total_records || 0;
        const invalidCount = data.invalid_records || 0;
        const cleanFileCount = data.clean_file ? 1 : 0;

        const statInvalid = document.getElementById('stat-invalid');
        const statClean = document.getElementById('stat-clean');
        if (statInvalid) statInvalid.textContent = invalidCount.toLocaleString();
        if (statClean) statClean.textContent = cleanFileCount.toLocaleString();
        
        const statCards = document.querySelectorAll('#results .stat-card .stat-num');
        if (statCards.length >= 3) {
            statCards[0].textContent = (data.total_records || 0).toLocaleString();
            statCards[1].textContent = (data.valid_records || 0).toLocaleString();
            statCards[2].textContent = (data.invalid_records || 0).toLocaleString();
        }
        
        // 2. Update Charts
        if (charts.pie) {
            charts.pie.data.datasets[0].data = [data.valid_records || 0, data.invalid_records || 0];
            charts.pie.update();
        }
        
        renderErrorTable(data.errors || []);
        
        // Populate Downloads
        const downloadsBody = document.querySelector('#downloads .panel-body');
        if (downloadsBody) {
            let downloadsHtml = '';
            if (data.clean_file) {
                downloadsHtml += `<a href="${API_BASE}/download/${data.clean_file}" class="btn btn-accent w-100 flex-between mb-2">
                    <span><i class="fa-solid fa-file-csv"></i> CLEANED CSV FILE</span>
                </a>`;
            }
            if (data.error_file) {
                downloadsHtml += `<a href="${API_BASE}/download/${data.error_file}" class="btn w-100 flex-between">
                    <span><i class="fa-solid fa-triangle-exclamation"></i> ERROR REPORT</span>
                </a>`;
            }
            downloadsBody.innerHTML = downloadsHtml;
        }
        
        // 4. Update Audit Log
        const auditTableBody = document.getElementById('auditLogTableBody');
        if (auditTableBody) {
            auditTableBody.innerHTML = `
                <tr>
                    <td>USER_ADMIN_99</td>
                    <td>Processed CSV</td>
                    <td class="text-muted">OK</td>
                    <td class="text-muted">Just now</td>
                </tr>
            `;
        }

        // 5. Update Output Files
        const outputsTbody = document.getElementById('outputFilesTableBody');
        if (outputsTbody) {
            let outputsHTML = '';
            if (validRows.length > 0) {
                outputsHTML += `
                    <tr>
                        <td>clean_data.csv</td>
                        <td class="accent-text">READY</td>
                        <td><button class="btn-sm" onclick="window.downloadCSV('clean')">[ DL ]</button></td>
                    </tr>
                `;
            }
            if (invalidRows.length > 0) {
                outputsHTML += `
                    <tr>
                        <td>error_report.csv</td>
                        <td class="accent-text">READY</td>
                        <td><button class="btn-sm" onclick="window.downloadCSV('errors')">[ DL ]</button></td>
                    </tr>
                `;
            }
            outputsTbody.innerHTML = outputsHTML || '<tr><td colspan="3" class="text-muted">No outputs</td></tr>';
        }

        // 6. Update CSV Chunks
        const chunksTbody = document.getElementById('csvChunksTableBody');
        if (chunksTbody) {
            let chunksHTML = '';
            const chunkSize = 100000;
            const totalChunks = Math.ceil(validRows.length / chunkSize);
            
            for (let i = 0; i < totalChunks; i++) {
                const rowsInChunk = (i === totalChunks - 1) ? (validRows.length - (i * chunkSize)) : chunkSize;
                chunksHTML += `
                    <tr>
                        <td>chunk_${i + 1}.csv</td>
                        <td class="text-muted">${rowsInChunk.toLocaleString()}</td>
                        <td><button class="btn-sm" onclick="window.downloadCSV('chunk', ${i})">[ DL ]</button></td>
                    </tr>
                `;
            }
            chunksTbody.innerHTML = chunksHTML || '<tr><td colspan="3" class="text-muted">No chunks available</td></tr>';
        }
    }

    function getErrorCategory(error) {
        const field = String(error.field || '').toLowerCase();
        const description = String(error.description || '').toLowerCase();
        const value = `${field} ${description}`;

        if (value.includes('phone')) return 'phone';
        if (value.includes('date')) return 'date';
        if (value.includes('duplicate')) return 'duplicate';
        return 'other';
    }

    function renderErrorTable(errors) {
        const errorTbody = document.querySelector('#results tbody');
        if (!errorTbody) return;

        const filteredErrors = currentErrorFilter === 'all'
            ? errors
            : errors.filter(err => getErrorCategory(err) === currentErrorFilter);

        if (!errors.length) {
            errorTbody.innerHTML = '<tr><td colspan="4" class="text-center">No errors found!</td></tr>';
            return;
        }

        if (!filteredErrors.length) {
            errorTbody.innerHTML = '<tr><td colspan="4" class="text-center">No errors match this filter.</td></tr>';
            return;
        }

        errorTbody.innerHTML = filteredErrors.map(err => `
            <tr data-error-category="${getErrorCategory(err)}">
                <td>${escapeHtml(err.row)}</td>
                <td>${escapeHtml(err.field)}</td>
                <td>${escapeHtml(err.invalid_value)}</td>
                <td>${escapeHtml(err.description)}</td>
            </tr>
        `).join('');
    }

    document.querySelectorAll('.filter-btn[data-error-filter]').forEach(button => {
        button.addEventListener('click', () => {
            currentErrorFilter = button.dataset.errorFilter;
            document.querySelectorAll('.filter-btn[data-error-filter]').forEach(btn => {
                btn.classList.toggle('active', btn === button);
            });

            if (latestValidationResult) {
                renderErrorTable(latestValidationResult.errors || []);
            }
        });
    });

    // --- AI Insights ---
    const aiInsightsBody = document.getElementById('aiInsightsBody');
    const btnRefreshAi = document.getElementById('btnRefreshAi');

    function setAiInsights(message, muted = false) {
        if (!aiInsightsBody) return;
        aiInsightsBody.textContent = message;
        aiInsightsBody.classList.toggle('text-muted', muted);
    }

    function updateAiInsights(validationData) {
        if (!aiInsightsBody) return;
        if (!validationData) {
            setAiInsights('Validate a dataset to generate AI-powered cleanup guidance.', true);
            return;
        }

        if (btnRefreshAi) {
            btnRefreshAi.disabled = true;
            btnRefreshAi.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> ANALYZING...';
        }
        setAiInsights('OpenAI is analyzing validation results...', true);

        fetch(`${API_BASE}/ai/insights`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(validationData)
        })
        .then(async res => {
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not generate AI insights.');
            return data;
        })
        .then(data => {
            setAiInsights(data.insights || 'No AI insights returned.');
            if (data.warning) {
                showToast('AI_FALLBACK', data.warning);
            } else {
                showToast('AI_OK', `Insights generated with ${data.model}.`);
            }
        })
        .catch(err => {
            setAiInsights(err.message, true);
            showToast('AI_ERR', err.message);
        })
        .finally(() => {
            if (btnRefreshAi) {
                btnRefreshAi.disabled = false;
                btnRefreshAi.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> ANALYZE';
            }
        });
    }

    if (btnRefreshAi) {
        btnRefreshAi.addEventListener('click', () => {
            if (!latestValidationResult) {
                showToast('AI_WAIT', 'Validate a dataset first.');
                return;
            }
            updateAiInsights(latestValidationResult);
        });
    }

    // --- CSV Splitter ---
    const splitter = document.getElementById('splitter');
    const customSplitSize = document.getElementById('customSplitSize');
    const btnCustomSplit = document.getElementById('btnCustomSplit');
    const chunksTbody = document.getElementById('csvChunksTableBody');

    function renderChunks(chunks) {
        if (!chunksTbody) return;
        if (!chunks || chunks.length === 0) {
            chunksTbody.innerHTML = '<tr><td colspan="3" class="text-muted">No chunks generated</td></tr>';
            return;
        }

        chunksTbody.innerHTML = chunks.map(chunk => `
            <tr>
                <td>${escapeHtml(chunk.filename)}</td>
                <td class="text-muted">${Number(chunk.rows || 0).toLocaleString()} rows</td>
                <td><a class="btn-sm" href="${API_BASE}/download/${encodeURIComponent(chunk.filename)}"><i class="fa-solid fa-download"></i> Download</a></td>
            </tr>
        `).join('');
    }

    function splitCurrentFile(chunkSize, triggerButton) {
        if (!currentUploadedFilename) {
            showToast('NO_FILE', 'Upload a file before splitting.');
            return;
        }

        const parsedSize = Number.parseInt(chunkSize, 10);
        if (!Number.isInteger(parsedSize) || parsedSize < 1) {
            showToast('SPLIT_ERR', 'Enter a row count greater than zero.');
            return;
        }

        if (triggerButton) {
            triggerButton.disabled = true;
            triggerButton.dataset.originalText = triggerButton.innerHTML;
            triggerButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> SPLITTING...';
        }

        fetch(`${API_BASE}/split`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filename: currentUploadedFilename,
                chunk_size: parsedSize
            })
        })
        .then(async res => {
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not split file.');
            return data;
        })
        .then(data => {
            renderChunks(data.chunks);
            showToast('SPLIT_OK', `Generated ${data.chunks.length} chunk file(s).`);
        })
        .catch(err => showToast('SPLIT_ERR', err.message))
        .finally(() => {
            if (triggerButton) {
                triggerButton.disabled = false;
                triggerButton.innerHTML = triggerButton.dataset.originalText;
            }
        });
    }

    if (splitter) {
        splitter.addEventListener('click', (event) => {
            const sizeButton = event.target.closest('[data-split-size]');
            if (sizeButton) {
                splitCurrentFile(sizeButton.dataset.splitSize, sizeButton);
            }
        });
    }

    if (btnCustomSplit) {
        btnCustomSplit.addEventListener('click', () => {
            splitCurrentFile(customSplitSize.value, btnCustomSplit);
        });
    }

    // --- Output Download Logic ---
    window.downloadCSV = function(type, chunkIndex = 0) {
        let dataToExport = [];
        let filename = 'export.csv';
        
        if (type === 'clean') {
            dataToExport = validRows;
            filename = 'clean_data.csv';
        } else if (type === 'errors') {
            dataToExport = invalidRows;
            filename = 'error_report.csv';
        } else if (type === 'chunk') {
            const chunkSize = 100000;
            const start = chunkIndex * chunkSize;
            const end = start + chunkSize;
            dataToExport = validRows.slice(start, end);
            filename = `chunk_${chunkIndex + 1}.csv`;
        }
        
        if (dataToExport.length === 0) {
            showToast('EXPORT_FAILED', 'No data available to download.');
            return;
        }
        
        const csvStr = Papa.unparse(dataToExport);
        const blob = new Blob([csvStr], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', filename);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    // --- 4. Toast Notification System (Disabled) ---
    function showToast() {}

    // --- 5. DataTables Initialization ---
    const errorData = [];

    if (document.getElementById('errorTable')) {
        $('#errorTable').DataTable({
            data: errorData,
            pageLength: 5,
            lengthMenu: [5, 10, 25],
            language: { search: "SEARCH_ERRORS: ", searchPlaceholder: "..." },
            columnDefs: [
                {
                    targets: 5, // Severity
                    render: function(data, type, row) {
                        if(data === 'HIGH') return `<span class="accent-text fw-bold">HIGH</span>`;
                        return data;
                    }
                },
                {
                    targets: 6, // Status
                    render: function(data, type, row) {
                        if(data === 'RES') return `<span class="text-muted">RES</span>`;
                        return `<span class="accent-text">UNRES</span>`;
                    }
                }
            ]
        });
    }

    // Populate Audit Logs
    const auditLogs = [];

    const auditTableBody = document.getElementById('auditLogTableBody');
    if (auditTableBody) {
        auditLogs.forEach(log => {
            let statusClass = log.status === 'OK' ? 'text-muted' : 'accent-text';

            auditTableBody.innerHTML += `
                <tr>
                    <td>${log.user}</td>
                    <td>${log.action}</td>
                    <td class="${statusClass}">${log.status}</td>
                    <td class="text-muted">${log.time}</td>
                </tr>
            `;
        });
    }

    // --- 6. Chart.js Initialization (Brutalist Style) ---
    if (typeof Chart !== 'undefined') {
        Chart.defaults.font.family = "'Space Mono', monospace";
        Chart.defaults.color = '#888888';
    }
    
    function initCharts() {
        if (typeof Chart === 'undefined') return;
        const isDark = htmlElement.classList.contains('dark-theme');
        const fgColor = isDark ? '#FFFFFF' : '#000000';
        const gridColor = isDark ? '#333333' : '#CCCCCC';
        const accentColor = '#E60000';

        // 1. Line Chart
        const lineCanvas = document.getElementById('lineChart');
        if (lineCanvas) {
            const lineCtx = lineCanvas.getContext('2d');
            charts.line = new Chart(lineCtx, {
                type: 'line',
                data: {
                    labels: ['M', 'T', 'W', 'T', 'F', 'S', 'S'],
                    datasets: [{
                        label: 'Processed',
                        data: [],
                        borderColor: fgColor,
                        backgroundColor: 'transparent',
                        borderWidth: 2,
                        tension: 0, // Sharp lines
                        pointBackgroundColor: fgColor,
                        pointRadius: 4,
                        pointHoverRadius: 6
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { grid: { color: gridColor, drawBorder: true } },
                        y: { grid: { color: gridColor, drawBorder: true }, beginAtZero: true }
                    }
                }
            });
        }

        // 2. Bar Chart
        const barCanvas = document.getElementById('barChart');
        if (barCanvas) {
            const barCtx = barCanvas.getContext('2d');
            charts.bar = new Chart(barCtx, {
                type: 'bar',
                data: {
                    labels: ['FMT', 'MISS', 'INV', 'MIS'],
                    datasets: [{
                        label: 'Errors',
                        data: [],
                        backgroundColor: accentColor,
                        borderWidth: 1,
                        borderColor: fgColor
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { grid: { display: false } },
                        y: { grid: { color: gridColor }, beginAtZero: true }
                    }
                }
            });
        }

        // 3. Doughnut Chart
        const doughnutCanvas = document.getElementById('doughnutChart');
        if (doughnutCanvas) {
            const doughnutCtx = doughnutCanvas.getContext('2d');
            charts.doughnut = new Chart(doughnutCtx, {
                type: 'doughnut',
                data: {
                    labels: ['CC', 'UPI', 'BANK', 'WLT'],
                    datasets: [{
                        data: [],
                        backgroundColor: [fgColor, '#888888', '#CCCCCC', accentColor],
                        borderWidth: 1,
                        borderColor: isDark ? '#0A0A0A' : '#FFFFFF'
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    cutout: '60%',
                    plugins: {
                        legend: { position: 'right', labels: { usePointStyle: false, boxWidth: 10 } }
                    }
                }
            });
        }

        // 4. Pie Chart
        const pieCanvas = document.getElementById('pieChart');
        if (pieCanvas) {
            const pieCtx = pieCanvas.getContext('2d');
            charts.pie = new Chart(pieCtx, {
                type: 'pie',
                data: {
                    labels: ['VALID', 'INVALID'],
                    datasets: [{
                        data: [],
                        backgroundColor: [fgColor, accentColor],
                        borderWidth: 1,
                        borderColor: isDark ? '#0A0A0A' : '#FFFFFF'
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { position: 'bottom', labels: { usePointStyle: false, boxWidth: 10 } }
                    }
                }
            });
        }
    }

    function updateChartsTheme(isDark) {
        if (typeof Chart === 'undefined') return;
        const fgColor = isDark ? '#FFFFFF' : '#000000';
        const gridColor = isDark ? '#333333' : '#CCCCCC';
        const bgColor = isDark ? '#0A0A0A' : '#FFFFFF';
        const accentColor = '#E60000';
        
        if (charts.line) {
            charts.line.data.datasets[0].borderColor = fgColor;
            charts.line.data.datasets[0].pointBackgroundColor = fgColor;
            charts.line.options.scales.x.grid.color = gridColor;
            charts.line.options.scales.y.grid.color = gridColor;
            charts.line.update();
        }
        if (charts.bar) {
            charts.bar.data.datasets[0].borderColor = fgColor;
            charts.bar.options.scales.y.grid.color = gridColor;
            charts.bar.update();
        }
        if (charts.doughnut) {
            charts.doughnut.data.datasets[0].backgroundColor = [fgColor, '#888888', '#CCCCCC', accentColor];
            charts.doughnut.data.datasets[0].borderColor = bgColor;
            charts.doughnut.update();
        }
        if (charts.pie) {
            charts.pie.data.datasets[0].backgroundColor = [fgColor, accentColor];
            charts.pie.data.datasets[0].borderColor = bgColor;
            charts.pie.update();
        }
    }

    // --- 7. Validation Rules Management ---
    const ruleForm = document.getElementById('ruleForm');
    const ruleCountryInput = document.getElementById('ruleCountry');
    const ruleCodeInput = document.getElementById('ruleCode');
    const ruleLengthInput = document.getElementById('ruleLength');
    const btnCancelRule = document.getElementById('btnCancelRule');

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (char) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        })[char]);
    }

    function resetRuleForm() {
        if (!ruleForm) return;
        ruleForm.reset();
        ruleCountryInput.disabled = false;
        btnCancelRule.classList.add('hidden');
    }

    function fetchRules() {
        fetch(`${API_BASE}/rules`)
            .then(res => res.json())
            .then(data => {
                const rulesTbody = document.querySelector('#rules tbody');
                if (rulesTbody) {
                    rulesTbody.innerHTML = '';
                    for (const [country, rule] of Object.entries(data)) {
                        const safeCountry = escapeHtml(country);
                        const safeCode = escapeHtml(rule.code);
                        const safeLength = escapeHtml(rule.length);
                        rulesTbody.innerHTML += `
                            <tr>
                                <td>${safeCountry}</td>
                                <td>${safeCode}</td>
                                <td>${safeLength}</td>
                                <td>
                                    <button class="btn-sm" title="Edit" type="button" data-rule-edit="${safeCountry}" data-rule-code="${safeCode}" data-rule-length="${safeLength}"><i class="fa-solid fa-pen"></i></button>
                                    <button class="btn-sm" title="Delete" type="button" data-rule-delete="${safeCountry}"><i class="fa-solid fa-trash"></i></button>
                                </td>
                            </tr>
                        `;
                    }
                }
            })
            .catch(err => showToast('RULE_ERR', `Could not load rules: ${err.message}`));
    }

    const btnAddRule = document.getElementById('btnAddRule');
    if (btnAddRule) {
        btnAddRule.addEventListener('click', () => {
            ruleCountryInput.focus();
        });
    }

    if (ruleForm) {
        ruleForm.addEventListener('submit', (event) => {
            event.preventDefault();

            const country = ruleCountryInput.value.trim();
            const code = ruleCodeInput.value.trim();
            const length = ruleLengthInput.value.trim();
            if (!country || !code || !length) {
                showToast('RULE_ERR', 'Country, code, and length are required.');
                return;
            }

            saveRule(country, code, length);
        });
    }

    if (btnCancelRule) {
        btnCancelRule.addEventListener('click', resetRuleForm);
    }

    const rulesPanel = document.getElementById('rules');
    if (rulesPanel) {
        rulesPanel.addEventListener('click', (event) => {
            const editButton = event.target.closest('[data-rule-edit]');
            const deleteButton = event.target.closest('[data-rule-delete]');

            if (editButton) {
                ruleCountryInput.value = editButton.dataset.ruleEdit;
                ruleCodeInput.value = editButton.dataset.ruleCode;
                ruleLengthInput.value = editButton.dataset.ruleLength;
                ruleCountryInput.disabled = true;
                btnCancelRule.classList.remove('hidden');
                ruleCodeInput.focus();
            }

            if (deleteButton) {
                deleteRule(deleteButton.dataset.ruleDelete);
            }
        });
    }

    function saveRule(country, code, length) {
        fetch(`${API_BASE}/rules`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ country, code, length })
        })
        .then(async res => {
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Rule could not be saved.');
            return data;
        })
        .then(data => {
            showToast('RULE_SAVED', data.message || 'Rule saved.');
            resetRuleForm();
            fetchRules();
        })
        .catch(err => showToast('RULE_ERR', err.message));
    }

    function deleteRule(country) {
        if (!confirm(`Are you sure you want to delete the rule for ${country}?`)) return;
        
        fetch(`${API_BASE}/rules/${encodeURIComponent(country)}`, {
            method: 'DELETE'
        })
        .then(async res => {
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Rule could not be deleted.');
            return data;
        })
        .then(data => {
            showToast('RULE_DELETED', data.message || 'Rule deleted.');
            resetRuleForm();
            fetchRules();
        })
        .catch(err => showToast('RULE_ERR', err.message));
    }

    // Initialize
    setTimeout(() => {
        initCharts();
        fetchRules();
        showToast('SYSTEM_INIT', '[OK] Core modules loaded.');
    }, 100);

});
