# Instagram Reels Carousel Setup Guide

## Overview
The front page now features an Instagram reels carousel that displays live content from @falcontimepieces. The carousel automatically refreshes every 12 hours to fetch new content.

## How It Works

### Architecture
- **Instagram Embed Script**: Uses Instagram's official embed script (no API key required)
- **Auto-Refresh**: Carousel refreshes every 12 hours (43,200,000ms)
- **Backend Integration**: Optional backend endpoint for automatic reel URL fetching
- **Fallback**: Graceful message shown when no reels are configured

### How to Add Instagram Reels

#### Option 1: Manual Configuration (Quick Start)
1. Find Instagram reel posts from @falcontimepieces
2. Copy the post URL (e.g., `https://www.instagram.com/p/ABC123/`)
3. Edit `index.html` and find the `instagramReelUrls` array (around line 3764)
4. Add URLs to the array:
```javascript
const instagramReelUrls = [
    'https://www.instagram.com/p/ABC123/',
    'https://www.instagram.com/p/DEF456/',
    'https://www.instagram.com/p/GHI789/',
    // Add more URLs as needed
];
```
5. Save and reload the page

#### Option 2: Backend API Integration (Automatic Updates)
For automatic reel fetching every 12 hours, implement a backend endpoint:

**Endpoint**: `GET /api/instagram-reels`

**Response Format**:
```json
{
    "reels": [
        "https://www.instagram.com/p/ABC123/",
        "https://www.instagram.com/p/DEF456/",
        "https://www.instagram.com/p/GHI789/"
    ]
}
```

The frontend will automatically:
- Call this endpoint on page load
- Retry every 12 hours to fetch latest reels
- Fall back to configured URLs if endpoint is unavailable
- Cache results in memory for performance

## Features

✅ **No API Key Required** - Uses Instagram's official embed script
✅ **Auto-Refresh** - Updates every 12 hours automatically
✅ **Responsive** - Adapts to different screen sizes
✅ **Drag-Enabled** - Users can drag the carousel horizontally
✅ **Backend Ready** - Easy to integrate with backend reel fetching service
✅ **Graceful Fallback** - Shows helpful message when no reels available

## Finding Instagram Reel URLs

1. Visit `https://www.instagram.com/falcontimepieces/`
2. Click on any reel post
3. Copy the URL from your browser's address bar
4. Format: `https://www.instagram.com/p/[POST_ID]/`

Or right-click the reel → "Copy link" → paste into the URLs array

## Carousel Interactions

- **Hover**: Instagram content displays with interaction buttons
- **Drag**: Click and drag left/right to manually scroll
- **Auto-Scroll**: Carousel automatically scrolls every 30 seconds
- **Click**: Click any reel to open in Instagram (new tab)

## CSS Customization

Default carousel dimensions:
- **Item Width**: 300px (minimum)
- **Item Height**: 400px
- **Gap**: 20px between items
- **Animation**: 30-second infinite scroll

To change dimensions, edit `.instagram-item` CSS (line ~945):
```css
.instagram-item {
    min-width: 300px;    /* Adjust width */
    height: 400px;       /* Adjust height */
}
```

## Troubleshooting

### No reels showing?
1. Check that `instagramReelUrls` array has valid Instagram URLs
2. Verify URLs are in format: `https://www.instagram.com/p/[ID]/`
3. Ensure posts are public (private accounts won't embed)
4. Check browser console for errors

### Carousel not updating?
1. For automatic backend updates, verify `/api/instagram-reels` endpoint is responding
2. Check that response has correct JSON format with `reels` array
3. Refresh page (manual refresh happens immediately, then every 12 hours)
4. Clear browser cache if needed

### Instagram embed not displaying?
1. Instagram's embed script loads asynchronously
2. Check that Instagram's embed script loaded: `window.instgrm.Embeds` exists
3. Verify post is public and shareable
4. Check for CORS issues in browser console

## Implementation Details

**File**: `index.html`
- Instagram embed script added to `<head>` (line ~20)
- Carousel HTML structure (lines ~2325-2339)
- JavaScript logic (lines ~3763-3816)
- CSS styling (lines ~944-951, responsive breakpoints)

**Key Functions**:
- `loadInstagramReels()` - Loads and renders reels
- `setInterval()` - Schedules 12-hour refresh
- `window.instgrm.Embeds.process()` - Processes Instagram embeds

## Future Enhancements

Possible improvements:
- Add reel caption display
- Show like/comment counts
- Filter by hashtag (#falcontimepieces)
- Lazy-load images for better performance
- Add reel counter/pagination
- Mobile-optimized view

## Contact & Support

For questions about the carousel implementation, refer to the codebase comments in `index.html` around the Instagram section.
