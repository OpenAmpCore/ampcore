package com.scalli.ampcore.mobile

import android.content.res.Configuration
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

// The page cannot see the system bars on its own. Measured on the test phone:
// all four env(safe-area-inset-*) report 0px even with viewport-fit=cover,
// because Chrome only maps *display cutout* geometry into them, never the status
// bar — while the window's real insets are [0,130][0,52], i.e. 40dp top and 16dp
// bottom at density 3.25. enableEdgeToEdge() draws under both and the window
// carries EDGE_TO_EDGE_ENFORCED, so there is no opting out: the app has to
// reserve that space itself.
//
// Padding the WebView View was tried twice and does nothing here, so the values
// go to CSS instead, into the same --k-safe-area-* variables Konsta's own
// pt-safe/px-safe utilities already read. Delivery is push *and* pull because
// neither alone covers first launch: a push alone is lost when Tauri navigates
// to the app URL afterwards (fresh document, inline styles gone), and a pull
// alone can run before the activity has resumed and read zeros.
class MainActivity : TauriActivity() {
  /** top,right,bottom,left in CSS px. Read from the JS bridge thread, written
   *  from the UI thread, hence volatile. */
  @Volatile
  private var insetCss: String = "0,0,0,0"
  private var webView: WebView? = null

  inner class InsetBridge {
    @JavascriptInterface
    fun get(): String = insetCss
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    // Injected into every document the WebView loads from here on, so it
    // survives Tauri's navigation to the app URL and any later reload.
    webView.addJavascriptInterface(InsetBridge(), "AmpCoreInsets")
    ViewCompat.setOnApplyWindowInsetsListener(webView) { _, insets -> refresh(); insets }
  }

  override fun onResume() {
    super.onResume()
    refresh()
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    refresh()
  }

  /** Reads the live insets on the UI thread and pushes them at the page. */
  private fun refresh() {
    val view = window.decorView
    view.post {
      val i = ViewCompat.getRootWindowInsets(view)?.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
      ) ?: return@post
      val d = resources.displayMetrics.density
      insetCss = "${i.top / d},${i.right / d},${i.bottom / d},${i.left / d}"
      webView?.evaluateJavascript("window.__ampcoreApplyInsets && window.__ampcoreApplyInsets()", null)
    }
  }
}
