import UIKit
import WebKit

/// 网页壳：一个 WKWebView 满屏装载联机贪吃蛇的线上页面。
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var web: WKWebView?

    /// 想改地址就改这里（比如本机调试用 http://192.168.1.x:3000/play.html）
    static let startURL = URL(string: "https://snake-online.up.railway.app/play.html")!

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let ws = scene as? UIWindowScene else { return }

        let win = UIWindow(windowScene: ws)
        let vc = UIViewController()
        vc.view.backgroundColor = UIColor(red: 0xAB / 255.0, green: 0xCD / 255.0, blue: 0xEF / 255.0, alpha: 1)

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        let web = WKWebView(frame: .zero, configuration: config)
        web.translatesAutoresizingMaskIntoConstraints = false
        web.navigationDelegate = self
        web.allowsBackForwardNavigationGestures = true
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.isOpaque = false
        web.backgroundColor = .clear

        vc.view.addSubview(web)
        NSLayoutConstraint.activate([
            web.leadingAnchor.constraint(equalTo: vc.view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: vc.view.trailingAnchor),
            web.topAnchor.constraint(equalTo: vc.view.topAnchor),
            web.bottomAnchor.constraint(equalTo: vc.view.bottomAnchor)
        ])
        self.web = web

        win.rootViewController = vc
        win.makeKeyAndVisible()
        window = win

        load()
    }

    private func load() {
        var req = URLRequest(url: Self.startURL)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        web?.load(req)
    }

    /// 断网/白屏时点一下重新加载
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {}
}

extension SceneDelegate: WKNavigationDelegate {
    /// 模拟器里 Railway 的证书链不被认作“私人连接”，WKWebView 会直接白屏。
    /// 这里对这一处域名放行（其余仍走系统默认校验）。
    func webView(_ webView: WKWebView,
                 didReceive challenge: URLAuthenticationChallenge,
                 completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              challenge.protectionSpace.host.hasSuffix("railway.app") else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showRetry("网络好像断开了")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showRetry("页面加载失败")
    }

    private func showRetry(_ text: String) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            self?.load()
        }
    }
}
