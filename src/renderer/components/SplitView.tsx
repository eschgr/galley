/**
 * The split view (split view & Show/Hide Source reading mode): rendered view
 * on the LEFT, source editor on the RIGHT, a draggable divider, and synchronized
 * scrolling. As of #26 the split
 * layout + its scroll-sync live PER TAB inside TabView (each open tab owns its own
 * editor/preview pair), so the shared SplitView component is gone — this module
 * now only carries the view-mode type both App and TabView share.
 *
 * Two view modes: 'split' (view + editor side by side) and 'preview' (the rendered
 * view fills the window, for reading). The global toggle lives in App; TabView
 * reads it to show/hide its editor pane.
 */
export type ViewMode = 'split' | 'preview';
export type { PreviewHandle } from './Preview';
