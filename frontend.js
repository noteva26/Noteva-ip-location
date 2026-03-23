/**
 * IP Location Plugin - Frontend
 * Fetches location data from plugin API and injects badges into comment DOM.
 * Works with any theme — finds comment elements by common CSS patterns.
 */
(function () {
  var PLUGIN_ID = 'ip-location';
  var locationCache = {}; // article_id -> {comment_id: location}
  var injecting = false;

  function initAfterReady() {
    var settings = Noteva.plugins.getSettings(PLUGIN_ID);
    if (settings.enabled === false || settings.enabled === 'false') {
      return;
    }

    // Hook into content rendering
    Noteva.hooks.on('content_render', function () {
      setTimeout(injectLocations, 500);
    });

    // MutationObserver fallback
    startObserver();

    // Initial injection
    setTimeout(injectLocations, 800);
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
   * Fetch locations from plugin API.
   */
  function fetchLocations(articleId, callback) {
    if (locationCache[articleId]) {
      return callback(locationCache[articleId]);
    }

    var url = '/api/v1/plugins/ip-location/api/locations?article_id=' + articleId;
    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        locationCache[articleId] = data || {};
        callback(locationCache[articleId]);
      })
      .catch(function (e) {
        console.warn('[ip-location] Failed to fetch locations:', e);
        callback({});
      });
  }

  /**
   * Find all comment elements and inject location badges.
   */
  function injectLocations() {
    if (injecting) return;
    injecting = true;

    // Find comment IDs from DOM
    var commentEls = document.querySelectorAll('[data-comment-id]');
    if (commentEls.length === 0) {
      // Try to find comments by other means
      commentEls = document.querySelectorAll('.comment-item, .comment, [class*="comment"]');
    }

    if (commentEls.length === 0) {
      injecting = false;
      return;
    }

    // Get article ID
    var articleId = getArticleId();
    
    // Also try to intercept the comments API response to get article_id
    if (!articleId) {
      // Try to get from comment elements - look for article_id in parent
      var wrapper = document.querySelector('[data-article-id]');
      if (wrapper) {
        articleId = parseInt(wrapper.getAttribute('data-article-id'), 10);
      }
    }

    if (!articleId) {
      injecting = false;
      return;
    }

    fetchLocations(articleId, function (locs) {
      commentEls.forEach(function (el) {
        // Skip if already has badge
        if (el.querySelector('.ip-loc-badge')) return;

        var commentId = el.getAttribute('data-comment-id');
        if (!commentId) return;

        var loc = locs[commentId] || locs[String(commentId)];
        if (!loc) return;

        var badge = document.createElement('span');
        badge.className = 'ip-loc-badge';
        badge.textContent = loc;

        // Find the best place to insert: author/meta area
        var target =
          el.querySelector('.comment-meta') ||
          el.querySelector('.comment-header') ||
          el.querySelector('.comment-info') ||
          el.querySelector('[class*="meta"]') ||
          el.querySelector('[class*="author"]') ||
          el.querySelector('[class*="name"]');

        if (target) {
          target.appendChild(badge);
        }
      });

      injecting = false;
    });
  }

  function startObserver() {
    if (!document.body) {
      setTimeout(startObserver, 100);
      return;
    }
    new MutationObserver(function () {
      var comments = document.querySelectorAll('[data-comment-id]:not(:has(.ip-loc-badge))');
      if (comments.length > 0) {
        setTimeout(injectLocations, 300);
      }
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
