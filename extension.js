/**
 * StatusTitleBar extension
 * v0.2
 *
 * This extension replaces the original AppMenuButton from the
 * gnome-shell panel with a new AppMenuButton that shows the
 * title of the current focused window, when maximized, instead 
 * of the application's name. If the focused window is not
 * maximized then it reverts to showing the application's name.
 *
 */

const Atk = imports.gi.Atk;
const Clutter = imports.gi.Clutter;
const Lang = imports.lang;
const Meta = imports.gi.Meta;
const St = imports.gi.St;
const Util = imports.misc.util;

const Shell = imports.gi.Shell;
const Main = imports.ui.main;
const Panel = imports.ui.panel;
const Tweener = imports.ui.tweener;
const PopupMenu = imports.ui.popupMenu;
const PanelMenu = imports.ui.panelMenu;
const Overview = imports.ui.overview;

const PANEL_ICON_SIZE = 24;

/**
 * AppMenuButton:
 *
 * This class manages the "application menu" component.  It tracks the
 * currently focused application.  However, when an app is launched,
 * this menu also handles startup notification for it.  So when we
 * have an active startup notification, we switch modes to display that.
 */
const AppMenuButton = new Lang.Class({
    Name: 'AppMenuButton',
    Extends: PanelMenu.Button,

    _init: function(menuManager) {
        this.parent(0.0, null, true);

        this.actor.accessible_role = Atk.Role.MENU;

        this._startingApps = [];

        this._menuManager = menuManager;
        this._targetApp = null;
        this._appMenuNotifyId = 0;
        this._actionGroupNotifyId = 0;

        let bin = new St.Bin({ name: 'windowTitle' });
        this.actor.add_actor(bin);

        this.actor.bind_property("reactive", this.actor, "can-focus", 0);
        this.actor.reactive = false;
        this._targetIsCurrent = false;

        this._container = new Shell.GenericContainer();
        bin.set_child(this._container);
        this._container.connect('get-preferred-width', Lang.bind(this, this._getContentPreferredWidth));
        this._container.connect('get-preferred-height', Lang.bind(this, this._getContentPreferredHeight));
        this._container.connect('allocate', Lang.bind(this, this._contentAllocate));

        this._iconBox = new Shell.Slicer({ name: 'appMenuIcon' });
        this._iconBox.connect('style-changed',
                              Lang.bind(this, this._onIconBoxStyleChanged));
        this._iconBox.connect('notify::allocation',
                              Lang.bind(this, this._updateIconBoxClip));
        this._container.add_actor(this._iconBox);
        this._label = new Panel.TextShadower();
        this._container.add_actor(this._label.actor);

        this._iconBottomClip = 0;

        this._visible = !Main.overview.visible;
        if (!this._visible)
            this.actor.hide();
        Main.overview.connect('hiding', Lang.bind(this, function () {
            this.show();
        }));
        Main.overview.connect('showing', Lang.bind(this, function () {
            this.hide();
        }));

        this._stop = true;

        this._spinner = new Panel.AnimatedIcon('process-working.svg',
                                         PANEL_ICON_SIZE);
        this._container.add_actor(this._spinner.actor);
        this._spinner.actor.lower_bottom();

        let tracker = Shell.WindowTracker.get_default();
        let appSys = Shell.AppSystem.get_default();
        tracker.connect('notify::focus-app', Lang.bind(this, this._focusAppChanged));
        appSys.connect('app-state-changed', Lang.bind(this, this._onAppStateChanged));

        global.window_manager.connect('switch-workspace', Lang.bind(this, this._sync));

        // replace this._sync with:
  		global.window_manager.connect("maximize", Lang.bind(this, this._onMaximize));
  		global.window_manager.connect("unmaximize", Lang.bind(this, this._onUnmaximize));
  
  		global.screen.connect("notify::n-workspaces", Lang.bind(this, this._changeWorkspaces));
  
  		this._changeWorkspaces();
    },

    show: function() {
        if (this._visible)
            return;

        this._visible = true;
        this.actor.show();

        if (!this._targetIsCurrent)
            return;

        this.actor.reactive = true;

        Tweener.removeTweens(this.actor);
        Tweener.addTween(this.actor,
                         { opacity: 255,
                           time: Overview.ANIMATION_TIME,
                           transition: 'easeOutQuad' });
    },

    hide: function() {
        if (!this._visible)
            return;

        this._visible = false;
        this.actor.reactive = false;
        if (!this._targetIsCurrent) {
            this.actor.hide();
            return;
        }

        Tweener.removeTweens(this.actor);
        Tweener.addTween(this.actor,
                         { opacity: 0,
                           time: Overview.ANIMATION_TIME,
                           transition: 'easeOutQuad',
                           onComplete: function() {
                               this.actor.hide();
                           },
                           onCompleteScope: this });
    },

    _onIconBoxStyleChanged: function() {
        let node = this._iconBox.get_theme_node();
        this._iconBottomClip = node.get_length('app-icon-bottom-clip');
        this._updateIconBoxClip();
    },

    _updateIconBoxClip: function() {
        let allocation = this._iconBox.allocation;
        if (this._iconBottomClip > 0)
            this._iconBox.set_clip(0, 0,
                                   allocation.x2 - allocation.x1,
                                   allocation.y2 - allocation.y1 - this._iconBottomClip);
        else
            this._iconBox.remove_clip();
    },

    stopAnimation: function() {
        if (this._stop)
            return;

        this._stop = true;
        Tweener.addTween(this._spinner.actor,
                         { opacity: 0,
                           time: SPINNER_ANIMATION_TIME,
                           transition: "easeOutQuad",
                           onCompleteScope: this,
                           onComplete: function() {
                               this._spinner.actor.opacity = 255;
                               this._spinner.actor.hide();
                           }
                         });
    },

    startAnimation: function() {
        this._stop = false;
        this._spinner.actor.show();
    },

    _getContentPreferredWidth: function(actor, forHeight, alloc) {
        let [minSize, naturalSize] = this._iconBox.get_preferred_width(forHeight);
        alloc.min_size = minSize;
        alloc.natural_size = naturalSize;
        [minSize, naturalSize] = this._label.actor.get_preferred_width(forHeight);
        alloc.min_size = alloc.min_size + Math.max(0, minSize - Math.floor(alloc.min_size / 2));
        alloc.natural_size = alloc.natural_size + Math.max(0, naturalSize - Math.floor(alloc.natural_size / 2));
    },

    _getContentPreferredHeight: function(actor, forWidth, alloc) {
        let [minSize, naturalSize] = this._iconBox.get_preferred_height(forWidth);
        alloc.min_size = minSize;
        alloc.natural_size = naturalSize;
        [minSize, naturalSize] = this._label.actor.get_preferred_height(forWidth);
        if (minSize > alloc.min_size)
            alloc.min_size = minSize;
        if (naturalSize > alloc.natural_size)
            alloc.natural_size = naturalSize;
    },

    _contentAllocate: function(actor, box, flags) {
        let allocWidth = box.x2 - box.x1;
        let allocHeight = box.y2 - box.y1;
        let childBox = new Clutter.ActorBox();

        let [minWidth, minHeight, naturalWidth, naturalHeight] = this._iconBox.get_preferred_size();

        let direction = this.actor.get_text_direction();

        let yPadding = Math.floor(Math.max(0, allocHeight - naturalHeight) / 2);
        childBox.y1 = yPadding;
        childBox.y2 = childBox.y1 + Math.min(naturalHeight, allocHeight);
        if (direction == Clutter.TextDirection.LTR) {
            childBox.x1 = 0;
            childBox.x2 = childBox.x1 + Math.min(naturalWidth, allocWidth);
        } else {
            childBox.x1 = Math.max(0, allocWidth - naturalWidth);
            childBox.x2 = allocWidth;
        }
        this._iconBox.allocate(childBox, flags);

        let iconWidth = childBox.x2 - childBox.x1;

        [minWidth, minHeight, naturalWidth, naturalHeight] = this._label.actor.get_preferred_size();

        yPadding = Math.floor(Math.max(0, allocHeight - naturalHeight) / 2);
        childBox.y1 = yPadding;
        childBox.y2 = childBox.y1 + Math.min(naturalHeight, allocHeight);

        if (direction == Clutter.TextDirection.LTR) {
            childBox.x1 = Math.floor(iconWidth / 2);
            childBox.x2 = Math.min(childBox.x1 + naturalWidth, allocWidth);
        } else {
            childBox.x2 = allocWidth - Math.floor(iconWidth / 2);
            childBox.x1 = Math.max(0, childBox.x2 - naturalWidth);
        }
        this._label.actor.allocate(childBox, flags);

        if (direction == Clutter.TextDirection.LTR) {
            childBox.x1 = Math.floor(iconWidth / 2) + this._label.actor.width;
            childBox.x2 = childBox.x1 + this._spinner.actor.width;
            childBox.y1 = box.y1;
            childBox.y2 = box.y2 - 1;
            this._spinner.actor.allocate(childBox, flags);
        } else {
            childBox.x1 = -this._spinner.actor.width;
            childBox.x2 = childBox.x1 + this._spinner.actor.width;
            childBox.y1 = box.y1;
            childBox.y2 = box.y2 - 1;
            this._spinner.actor.allocate(childBox, flags);
        }
    },

    _onAppStateChanged: function(appSys, app) {
        let state = app.state;
        if (state != Shell.AppState.STARTING) {
            this._startingApps = this._startingApps.filter(function(a) {
                return a != app;
            });
        } else if (state == Shell.AppState.STARTING) {
            this._startingApps.push(app);
        }
        // For now just resync on all running state changes; this is mainly to handle
        // cases where the focused window's application changes without the focus
        // changing.  An example case is how we map OpenOffice.org based on the window
        // title which is a dynamic property.
        this._sync();
    },

    _focusAppChanged: function() {
        let tracker = Shell.WindowTracker.get_default();
        let focusedApp = tracker.focus_app;
        if (!focusedApp) {
            // If the app has just lost focus to the panel, pretend
            // nothing happened; otherwise you can't keynav to the
            // app menu.
            if (global.stage_input_mode == Shell.StageInputMode.FOCUSED)
                return;
        }
        this._sync();
    },

    _sync: function() {
        let tracker = Shell.WindowTracker.get_default();
        let focusedApp = tracker.focus_app;
        let lastStartedApp = null;
        let workspace = global.screen.get_active_workspace();
        for (let i = 0; i < this._startingApps.length; i++)
            if (this._startingApps[i].is_on_workspace(workspace))
                lastStartedApp = this._startingApps[i];

        let targetApp = focusedApp != null ? focusedApp : lastStartedApp;

        if (targetApp == null) {
            if (!this._targetIsCurrent)
                return;

            this.actor.reactive = false;
            this._targetIsCurrent = false;

            Tweener.removeTweens(this.actor);
            Tweener.addTween(this.actor, { opacity: 0,
                                           time: Overview.ANIMATION_TIME,
                                           transition: 'easeOutQuad' });
            return;
        }

        if (!targetApp.is_on_workspace(workspace))
            return;

        if (!this._targetIsCurrent) {
            this.actor.reactive = true;
            this._targetIsCurrent = true;

            Tweener.removeTweens(this.actor);
            Tweener.addTween(this.actor, { opacity: 255,
                                           time: Overview.ANIMATION_TIME,
                                           transition: 'easeOutQuad' });
        }

        /* Added */
		let win = global.display.focus_window;

		if (!win._notifyTitleId) {
			this._initWindow(win);
		}

		this._changeTitle(win, targetApp)
        /* End added */

        if (targetApp == this._targetApp) {
            if (targetApp && targetApp.get_state() != Shell.AppState.STARTING) {
                this.stopAnimation();
                this._maybeSetMenu();
            }
            return;
        }

        this._spinner.actor.hide();
        if (this._iconBox.child != null)
            this._iconBox.child.destroy();
        this._iconBox.hide();
        //this._label.setText('');

        if (this._appMenuNotifyId)
            this._targetApp.disconnect(this._appMenuNotifyId);
        if (this._actionGroupNotifyId)
            this._targetApp.disconnect(this._actionGroupNotifyId);
        if (targetApp) {
            this._appMenuNotifyId = targetApp.connect('notify::menu', Lang.bind(this, this._sync));
            this._actionGroupNotifyId = targetApp.connect('notify::action-group', Lang.bind(this, this._sync));
        } else {
            this._appMenuNotifyId = 0;
            this._actionGroupNotifyId = 0;
        }

        this._targetApp = targetApp;
        let icon = targetApp.get_faded_icon(2 * PANEL_ICON_SIZE);

        //this._label.setText(targetApp.get_name());
        this.setName(targetApp.get_name());

        this._iconBox.set_child(icon);
        this._iconBox.show();

        if (targetApp.get_state() == Shell.AppState.STARTING)
            this.startAnimation();
        else
            this._maybeSetMenu();

        this.emit('changed');
    },

    _maybeSetMenu: function() {
        let menu;

        if (this._targetApp.action_group && this._targetApp.menu) {
            if (this.menu instanceof PopupMenu.RemoteMenu &&
                this.menu.actionGroup == this._targetApp.action_group)
                return;

            menu = new PopupMenu.RemoteMenu(this.actor, this._targetApp.menu, this._targetApp.action_group);
        } else {
            if (this.menu && !(this.menu instanceof PopupMenu.RemoteMenu))
                return;

            // fallback to older menu
            menu = new PopupMenu.PopupMenu(this.actor, 0.0, St.Side.TOP, 0);
            menu.addAction(_("Quit"), Lang.bind(this, function() {
                this._targetApp.request_quit();
            }));
        }

        this.setMenu(menu);
        this._menuManager.addMenu(menu);
    },
 
 	_onTitleChanged: function(win) {
 		if (win.has_focus()) {
 			let tracker = Shell.WindowTracker.get_default();
 			let app = tracker.get_window_app(win);
 
 			this._changeTitle(win, app);
 		}
 	},
 
 	_changeTitle: function(win, app) {
 		this._label.setText("");
 		let maximizedFlags = Meta.MaximizeFlags.HORIZONTAL | Meta.MaximizeFlags.VERTICAL;
 
 		if (win.get_maximized() == maximizedFlags) {
 			this._label.setText(win.title);
 		} else {
 			this._label.setText(app.get_name());
 		}
 	},
 
 	_onMaximize: function(shellwm, actor) {
 		let win = actor.get_meta_window();
 
 		this._onTitleChanged(win);
 	},
 
 	_onUnmaximize: function(shellwm, actor) {
 		let win = actor.get_meta_window();
 
 		this._onTitleChanged(win);
 	},
 
 	_windowAdded: function(metaWorkspace, metaWindow) {
 		this._initWindow(metaWindow);
     },
 
     _windowRemoved: function(metaWorkspace, metaWindow) {
 		if (metaWorkspace == global.screen.get_active_workspace()) {
 			this._sync();
 		}
     },
 
 	_changeWorkspaces: function() {
 		for ( let i=0; i < global.screen.n_workspaces; ++i ) {
             let ws = global.screen.get_workspace_by_index(i);
 
 			if (ws._windowRemovedId) {
 				ws.disconnect(ws._windowRemovedId);
 			}
 
             ws._windowRemovedId = ws.connect('window-removed',
                                     Lang.bind(this, this._windowRemoved));
         }
 	},
 
 	_initWindow: function(win) {
 		if (win._notifyTitleId) {
 			win.disconnect(win._notifyTitleId);
 		}
 
 		win._notifyTitleId = win.connect("notify::title", Lang.bind(this, this._onTitleChanged));
 	}

});


let menu=null;
function init() {
}

function enable() {
    menu = Main.panel._appMenu;

    /* Do monkey patching */

 	menu._onTitleChanged = function(win) {
 		if (win.has_focus()) {
 			let tracker = Shell.WindowTracker.get_default();
 			let app = tracker.get_window_app(win);
 			this._changeTitle(win, app);
 		}
 	};
 
 	menu._changeTitle = function(win, app) {
 		this._label.setText("");
 		let maximizedFlags = Meta.MaximizeFlags.HORIZONTAL | Meta.MaximizeFlags.VERTICAL;
 		if (win.get_maximized() == maximizedFlags) {
 			this._label.setText(win.title);
 		} else {
 			this._label.setText(app.get_name());
 		}
 	};
 
 	menu._onMaximize = function(shellwm, actor) {
 		let win = actor.get_meta_window();
 		this._onTitleChanged(win);
 	};
 
 	menu._onUnmaximize = function(shellwm, actor) {
 		let win = actor.get_meta_window();
 		this._onTitleChanged(win);
 	};
 
 	menu._windowAdded = function(metaWorkspace, metaWindow) {
 		this._initWindow(metaWindow);
    };
 
    menu._windowRemoved = function(metaWorkspace, metaWindow) {
 		if (metaWorkspace == global.screen.get_active_workspace()) {
 			this._sync();
 		}
    };
 
 	menu._changeWorkspaces = function() {
 		for ( let i=0; i < global.screen.n_workspaces; ++i ) {
             let ws = global.screen.get_workspace_by_index(i);
 			if (ws._windowRemovedId) {
 				ws.disconnect(ws._windowRemovedId);
 			}
             ws._windowRemovedId = ws.connect('window-removed',
                                     Lang.bind(this, this._windowRemoved));
         }
    };
 
 	menu._initWindow = function(win) {
 		if (win._notifyTitleId) {
 			win.disconnect(win._notifyTitleId);
 		}
 		win._notifyTitleId = win.connect("notify::title", Lang.bind(this, this._onTitleChanged));
 	};

    /* __init__:
     * menu.actor ('bin'): name change to 'windowTitle'
     * don't call _sync: replace with a whole bunch of connects
     *
     * _sync:
     * added _changeWindowTitle
     * removed a few SetText
     */
    menu._oldSync = menu._sync;
    menu._oldInit = menu._init;
   
    // TODO: use of 'this'? 
    menu._init = function(menuManager) {
        // menu._oldInit(menuManager) --> 'windowTitle', calls _sync!
  		global.window_manager.connect("maximize", Lang.bind(this, this._onMaximize));
  		global.window_manager.connect("unmaximize", Lang.bind(this, this._onUnmaximize));
  		global.screen.connect("notify::n-workspaces", Lang.bind(this, this._changeWorkspaces));
  		this._changeWorkspaces();
    }

    menu._sync = function() {
        // menu._oldSync();
        /* Added */
		let win = global.display.focus_window;

		if (!win._notifyTitleId) {
			this._initWindow(win);
		}

		this._changeTitle(win, targetApp)
        /* End added */
        // blah there's all sorts of conditions under which you'd return.
    }
    // TODO: monkey patch these.


}


function disable() {
    if ( !menu ) {
        return;
    }
    menu._sync = menu._OldSync;
    menu._init = menu._OldInit;
    menu._OldSync = null;
    menu._OldInit = null;

   /* Undo monkey patching */
    menu._onTitleChanged  = null;
 	menu._changeTitle  = null;
 	menu._onMaximize  = null;
 	menu._onUnmaximize  = null;
 	menu._windowAdded  = null;
    menu._windowRemoved  = null;
 	menu._changeWorkspaces  = null;
 	menu._initWindow  = null;
}

