return {
  apply(ctx) {
    // settingsfix client half: align the native Settings row with the
    // sidebar badges and anchor the cordis dynamic panel. All values are
    // measured on the live page (webview 1136x1222, dpr 1):
    //   trigger: margin 4px -4px / padding 6 2 6 10 / 34px tall / 264px wide / x=8
    //   badges:  margin 0 / padding 0 8 0 6 / 49px tall / 256px wide / x=12
    //   trigger label x=42 (16px svg icon) vs badge label x=40 (14px icon)
    //   cordis panel fixed inset bottom: 128px -> 112px
    styles.insert([
      '[class*="VOzbGW_trigger"] { box-sizing: border-box; margin: 8px 0 0 !important; padding: 0 8px 0 6px !important; width: 256px !important; height: 49px !important; border-radius: 12px !important; }',
      '[class*="VOzbGW_trigger"] [data-slot="settings.trigger"] svg { width: 14px !important; height: 14px !important; }',
      '[class*="Nqubda_panel"] { bottom: 112px !important; }',
    ].join('\n'))
  },
}
