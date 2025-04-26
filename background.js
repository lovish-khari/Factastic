chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "factCheckAI",
    title: "Fact check with AI",
    contexts: ["selection"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "factCheckAI") {
    chrome.tabs.sendMessage(tab.id, { action: "checkInjection" }, (response) => {
      if (chrome.runtime.lastError || !response || !response.injected) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        }, () => {
          if (chrome.runtime.lastError) {
            console.error('Error injecting script: ' + chrome.runtime.lastError.message);
            return;
          }
          sendFactCheckMessage(tab.id, info.selectionText, tab.url);
        });
      } else {
        sendFactCheckMessage(tab.id, info.selectionText, tab.url);
      }
    });
  }
});

function sendFactCheckMessage(tabId, text, url) {
  chrome.tabs.sendMessage(tabId, { action: "showLoading" });

  chrome.storage.sync.get('apiKey', async (data) => {
    if (data.apiKey) {
      try {
        const contextText = await fetchPageContent(tabId);
        const response = await factCheckWithAI(text, contextText, url, data.apiKey);
        console.log('Sending fact check result to content script:', response);
        chrome.tabs.sendMessage(tabId, {
          action: "factCheckResult",
          data: response
        });
      } catch (error) {
        console.error('Error in fact checking:', error);
        chrome.tabs.sendMessage(tabId, {
          action: "factCheckError",
          error: error.message
        });
      }
    } else {
      chrome.tabs.sendMessage(tabId, {
        action: "factCheckError",
        error: "API Key not found. Please set it in the extension popup."
      });
    }
  });
}

async function fetchPageContent(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => document.body.innerText
    });
    return result;
  } catch (error) {
    console.error('Error fetching page content:', error);
    return '';
  }
}

async function factCheckWithAI(text, contextText, url, apiKey) {
  const options = {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'content-type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-chat-v3-0324:free',
      messages: [
        {
          role: 'system',
          content: `You are a multilingual fact-checking assistant. Your primary tasks are:

Format your response EXACTLY as follows, in the detected language:

1.Provide a truth percentage based on the reliability and consensus of the sources. The percentage should reflect how well the selected text is supported by the sources, not the number of sources found.
2.Write a fact check (3-4 concise sentences) that directly addresses the claims in the selected text.
3.Provide context (3-4 concise sentences) that places the selected text within the broader topic or article it's from.
4.Aim to provide 5-10 sources, prioritizing diversity of domains. Do not invent sources or include unrelated sources.

Sources:
1. [source 1 title](URL)
2. [source 2 title](URL)
...

Truth: [percentage]

Fact Check: [your fact check with inline source references, e.g. [1], [2], etc.]

Context: [your context with inline source references, e.g. [1], [2], etc.]

If you cannot find enough reliable sources to fact-check the statement, say so explicitly and explain why. If a claim is widely accepted as common knowledge, state this and provide general reference sources.`
        },
        {
          role: 'user',
          content: `Fact check the following selected text: "${text}"\n\nBroader context from the page:\n${contextText}\n\nPage URL: ${url}`
        }
      ],
      max_tokens: 2048,
      temperature: 0.1
    })
  };

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', options);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText}`);
  }

  const result = await response.json();

  if (result.choices && result.choices.length > 0) {
    return result.choices[0].message.content;
  } else {
    throw new Error('Invalid response structure from OpenRouter API');
  }
}