// content.js

const BUTTON_ID_PREFIX = 'drawio-launcher-btn-';

function detectDiagramType(text, element) {
    if (!text || text.length < 10) return null;

    // Check for Mermaid
    // 1. Check class on the CODE element (most common)
    if (element && (element.classList.contains('language-mermaid') || element.classList.contains('mermaid'))) {
        return 'mermaid';
    }
    // 2. Check class on the PRE element (sometimes)
    const pre = element ? element.closest('pre') : null;
    if (pre && (pre.classList.contains('language-mermaid') || pre.classList.contains('mermaid'))) {
        return 'mermaid';
    }
    // 3. Heuristic check for Mermaid keywords if no class found (optional, but good for robustness)
    if (/^\s*(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|gitGraph)/.test(text)) {
        return 'mermaid';
    }

    // Check for Draw.io XML
    if (text.includes('</mxfile>"') || (text.includes('</mxGraphModel>'))) {
        return 'xml';
    }

    return null;
}

function createButton(content, type) {
    const btn = document.createElement('button');
    btn.textContent = 'Open in Draw.io';
    btn.style.cssText = `
    float: right;
    margin: 8px;
    padding: 0 12px;
    height: 28px;
    line-height: 28px;
    font-size: 12px;
    background-color: #f08705;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    z-index: 1000;
    font-family: sans-serif;
    position: relative;
    white-space: nowrap;
    box-sizing: border-box;
  `;
    btn.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent triggering code block selection
        chrome.runtime.sendMessage({ action: 'open_drawio', content: content, type: type });
    });
    return btn;
}

// Debounce function to limit frequent updates
function debounce(func, wait) {
    let timeout;
    return function (...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

// Set to track blocks that need processing
const pendingBlocks = new Set();

const processPendingBlocks = debounce(() => {
    pendingBlocks.forEach(block => {
        // If already processed successfully, skip (unless we want to support updates, but usually once is enough)
        if (block.dataset.drawioProcessed === 'true') return;

        const codeElement = block.querySelector('code');
        const text = codeElement ? codeElement.textContent : block.textContent;

        const type = detectDiagramType(text, codeElement || block);

        if (type) {
            block.dataset.drawioProcessed = 'true';

            // Create Top Button
            const btnTop = createButton(text, type);
            btnTop.style.float = 'right';
            btnTop.style.marginRight = '8px';
            btnTop.style.marginTop = '8px';

            // Create Bottom Button
            const btnBottom = createButton(text, type);
            btnBottom.style.float = 'right';
            btnBottom.style.marginRight = '8px';
            btnBottom.style.marginBottom = '8px';
            btnBottom.style.marginTop = '8px'; // Add some space from text

            // Insert Top Button
            if (block.firstChild) {
                block.insertBefore(btnTop, block.firstChild);
            } else {
                block.appendChild(btnTop);
            }

            // Insert Bottom Button
            block.appendChild(btnBottom);

            // Remove from pending once processed
            pendingBlocks.delete(block);
        }
    });
    // Clear any remaining (failed) blocks from the set to avoid memory leaks? 
    // No, we want to keep retrying if they are still being streamed.
    // But we should probably clear them if they are detached.
    // For now, simple set is fine, but let's clear the set after processing to avoid re-checking static failed blocks forever?
    // Actually, if it failed, we might want to check again later if more text arrives.
    // So we only remove from Set if SUCCESS.
    // But we need to clear the Set of *processed* items.
    // If it failed, we keep it? No, if it failed, we wait for next mutation to add it back.
    pendingBlocks.clear();
}, 1000); // Wait 1s after last change to process (good for streaming completion)

// Observer for dynamic content (SPA) and Streaming
const observer = new MutationObserver((mutations) => {
    let shouldProcess = false;

    mutations.forEach(mutation => {
        // Check added nodes
        mutation.addedNodes.forEach(node => {
            if (node.nodeType === 1) { // Element
                // Check if it is a PRE or contains PRE
                if (node.tagName === 'PRE') {
                    pendingBlocks.add(node);
                    shouldProcess = true;
                } else {
                    // Check if the added node is inside a PRE
                    const parentPre = node.closest('pre');
                    if (parentPre) {
                        pendingBlocks.add(parentPre);
                        shouldProcess = true;
                    } else if (node.querySelectorAll) {
                        const pres = node.querySelectorAll('pre');
                        pres.forEach(p => pendingBlocks.add(p));
                        if (pres.length > 0) shouldProcess = true;
                    }
                }
            } else if (node.nodeType === 3) { // Text node
                // If text added, check if parent is inside PRE
                const parent = node.parentElement;
                if (parent) {
                    const parentPre = parent.closest('pre');
                    if (parentPre) {
                        pendingBlocks.add(parentPre);
                        shouldProcess = true;
                    }
                }
            }
        });

        // Check characterData changes (text updates)
        if (mutation.type === 'characterData') {
            const node = mutation.target;
            const parent = node.parentElement;
            if (parent) {
                const parentPre = parent.closest('pre');
                if (parentPre) {
                    pendingBlocks.add(parentPre);
                    shouldProcess = true;
                }
            }
        }
    });

    if (shouldProcess) {
        processPendingBlocks();
    }
});

observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true // Important for streaming text updates
});

// Initial pass
document.querySelectorAll('pre').forEach(pre => {
    pendingBlocks.add(pre);
});
processPendingBlocks();

// Listen for context menu requests
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'get_selection_context') {
        const selection = window.getSelection();
        let content = selection.toString();
        let type = detectDiagramType(content);

        if (selection.rangeCount > 0) {
            const anchorNode = selection.anchorNode;
            if (anchorNode) {
                // Find parent PRE or CODE
                const element = anchorNode.nodeType === 1 ? anchorNode : anchorNode.parentElement;
                const pre = element.closest('pre');

                if (pre) {
                    // If we are inside a PRE, try to get the full code content
                    const codeElement = pre.querySelector('code');
                    const fullText = codeElement ? codeElement.textContent : pre.textContent;

                    // Check if the selection is actually part of this block
                    // (Simple check: is the selected text contained in the full text?)
                    // A better check might be to see if the selection range intersects the pre

                    // For now, if we found a PRE, let's assume the user wants that block's content
                    // This fixes the "partial selection" or "formatted selection" issue
                    content = fullText;
                    type = detectDiagramType(content, codeElement || pre);
                }
            }
        }

        sendResponse({ content: content, type: type });
    }
});
