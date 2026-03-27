/**
 * IP Location Plugin - Frontend
 * Fetches location data from plugin API and injects badges into comment DOM.
 * Works with any theme — uses multiple strategies to find comment elements.
 */
(function () {
  var PLUGIN_ID = 'ip-location';
  var locationCache = {}; // article_id -> {comment_id: location}
  var injected = false;

  function initAfterReady() {
    var settings = Noteva.plugins.getSettings(PLUGIN_ID);
    if (settings.enabled === false || settings.enabled === 'false') {
      return;
    }

    // Hook into content rendering
    Noteva.hooks.on('content_render', function () {
      injected = false;
      setTimeout(tryInject, 500);
    });

    // Listen for comment creation events
    Noteva.events.on('comment:create', function () {
      injected = false;
      setTimeout(tryInject, 1500);
    });

    // MutationObserver for dynamic comment loading
    startObserver();

    // Initial injection with delay for React render
    setTimeout(tryInject, 1000);
  }

  /**
   * Detect the current article ID from the URL or page context.
   */
  function getArticleId() {
    // Try Noteva SDK
    if (typeof Noteva !== 'undefined' && Noteva.page && Noteva.page.articleId) {
      return Noteva.page.articleId;
    }
    // Try from URL: /posts/{slug} or /posts/{id}
    var match = window.location.pathname.match(/\/posts\/(\d+)/);
    if (match) return parseInt(match[1], 10);
    // Try from DOM
    var el = document.querySelector('[data-article-id]');
    if (el) return parseInt(el.getAttribute('data-article-id'), 10);
    return null;
  }

  /**
   * Fetch locations from plugin API (with cache).
   */
  function fetchLocations(articleId) {
    return new Promise(function (resolve) {
      if (locationCache[articleId]) {
        return resolve(locationCache[articleId]);
      }
      // Use built-in plugin data API instead of WASM API endpoint
      var url = '/api/v1/plugins/ip-location/data/article_locs:' + articleId;
      fetch(url)
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (data) {
          // Plugin data API returns {"value": "{\"2\":\"加州\"}"} — parse the inner JSON
          var locs = {};
          try {
            if (data && data.value) {
              locs = JSON.parse(data.value);
            }
          } catch (e) {
            console.warn('[ip-location] Failed to parse location data:', e);
          }
          locationCache[articleId] = locs;
          resolve(locs);
        })
        .catch(function (e) {
          console.warn('[ip-location] Failed to fetch locations:', e);
          resolve({});
        });
    });
  }

  /**
   * Flatten nested comment tree to match DOM render order (DFS).
   */
  function flattenComments(comments) {
    var result = [];
    if (!comments) return result;
    for (var i = 0; i < comments.length; i++) {
      result.push(comments[i]);
      if (comments[i].replies && comments[i].replies.length > 0) {
        var nested = flattenComments(comments[i].replies);
        for (var j = 0; j < nested.length; j++) {
          result.push(nested[j]);
        }
      }
    }
    return result;
  }

  /**
   * Strategy 1: Find comment elements by [data-comment-id] attribute.
   * Returns array of {el, commentId} objects.
   */
  function findByDataAttr() {
    var els = document.querySelectorAll('[data-comment-id]');
    var result = [];
    els.forEach(function (el) {
      result.push({
        el: el,
        commentId: el.getAttribute('data-comment-id')
      });
    });
    return result;
  }

  /**
   * Strategy 2: Match DOM elements to comments by order.
   * Finds avatar images inside the comments container, walks up to comment root,
   * then maps by index to the flattened comment list from the API.
   */
  function findByStructure(flatComments) {
    // Find the comments container — typically a divide-y div inside a Card
    var containers = document.querySelectorAll('.divide-y');
    var commentContainer = null;
    for (var i = 0; i < containers.length; i++) {
      // The comments container should contain avatar images
      if (containers[i].querySelector('img.rounded-full') ||
          containers[i].querySelector('img[class*="rounded"]')) {
        commentContainer = containers[i];
        break;
      }
    }
    if (!commentContainer) return [];

    // Find all avatar images within the container — each represents one comment
    var avatars = commentContainer.querySelectorAll('img.rounded-full');
    if (avatars.length === 0) {
      avatars = commentContainer.querySelectorAll('img[class*="rounded"]');
    }

    var result = [];
    for (var i = 0; i < avatars.length; i++) {
      if (i >= flatComments.length) break;

      // Walk up from img to find the comment root element
      // Typical structure: commentRoot > div.flex > img
      var flexParent = avatars[i].parentElement;
      var commentRoot = flexParent ? flexParent.parentElement : null;
      if (!commentRoot) continue;

      result.push({
        el: commentRoot,
        commentId: String(flatComments[i].id)
      });
    }
    return result;
  }

  /**
   * Find the best target element within a comment to insert the badge.
   */
  function findInsertTarget(el) {
    return (
      el.querySelector('.comment-meta') ||
      el.querySelector('.comment-header') ||
      el.querySelector('.comment-info') ||
      el.querySelector('[class*="meta"]') ||
      // Default theme: the first row with nickname + date
      // It's a flex div containing a .font-medium span (nickname)
      (function () {
        var spans = el.querySelectorAll('span.font-medium');
        if (spans.length > 0) {
          return spans[0].parentElement; // the flex container holding nickname + date
        }
        return null;
      })() ||
      el.querySelector('[class*="author"]') ||
      el.querySelector('[class*="name"]')
    );
  }

  /**
   * Main injection logic.
   */
  function tryInject() {
    if (injected) return;

    var articleId = getArticleId();
    if (!articleId) return;

    // Strategy 1: Try data-comment-id attributes first
    var mappings = findByDataAttr();

    if (mappings.length > 0) {
      // Direct mapping available
      fetchLocations(articleId).then(function (locs) {
        injectBadges(mappings, locs);
      });
      return;
    }

    // Strategy 2: Use Noteva SDK to get comments, then match by DOM order
    if (typeof Noteva === 'undefined' || !Noteva.comments) return;

    Promise.all([
      Noteva.comments.list(articleId),
      fetchLocations(articleId)
    ]).then(function (results) {
      var comments = results[0];
      var locs = results[1];

      if (!comments || comments.length === 0) return;
      if (!locs || Object.keys(locs).length === 0) return;

      var flatComments = flattenComments(comments);
      var mappings = findByStructure(flatComments);

      if (mappings.length > 0) {
        injectBadges(mappings, locs);
      }
    }).catch(function (e) {
      console.warn('[ip-location] Injection failed:', e);
    });
  }

  /**
   * Inject location badges into mapped comment elements.
   */
  function injectBadges(mappings, locs) {
    var anyInjected = false;
    for (var i = 0; i < mappings.length; i++) {
      var el = mappings[i].el;
      var commentId = mappings[i].commentId;

      // Skip if already has badge
      if (el.querySelector('.ip-loc-badge')) continue;

      var loc = locs[commentId] || locs[String(commentId)];
      if (!loc) continue;

      var badge = document.createElement('span');
      badge.className = 'ip-loc-badge';
      badge.textContent = loc;

      var target = findInsertTarget(el);
      if (target) {
        target.appendChild(badge);
        anyInjected = true;
      }
    }
    if (anyInjected) {
      injected = true;
    }
  }

  function startObserver() {
    if (!document.body) {
      setTimeout(startObserver, 100);
      return;
    }
    var debounceTimer = null;
    new MutationObserver(function () {
      // Reset injected flag if DOM changed (e.g. new comments loaded)
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        // Check if there are comment elements without badges
        var hasBadges = document.querySelectorAll('.ip-loc-badge').length;
        var hasAvatars = document.querySelectorAll('.divide-y img.rounded-full').length +
                         document.querySelectorAll('[data-comment-id]').length;
        if (hasAvatars > 0 && hasBadges < hasAvatars) {
          injected = false;
          tryInject();
        }
      }, 500);
    }).observe(document.body, { childList: true, subtree: true });
  }

  // Wait for Noteva SDK
  function waitAndInit() {
    if (typeof Noteva !== 'undefined' && Noteva.ready) {
      Noteva.ready(initAfterReady);
    } else {
      setTimeout(waitAndInit, 100);
    }
  }
  waitAndInit();
})();
