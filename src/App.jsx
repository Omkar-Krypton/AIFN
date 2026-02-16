import { useEffect, useState } from "react";

function App() {
  const [list, setList] = useState([]);

  useEffect(() => {
    const listener = (msg) => {
      if (msg?.source !== "API_INTERCEPTOR") return;

      setList((prev) => [
        {
          type: msg.kind,
          url: msg.url,
          status: msg.status,
          data: msg.data
        },
        ...prev
      ]);
    };

    chrome.runtime.onMessage.addListener(listener);

    return () => {
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, []);

  return (
    <div style={{ padding: 10, width: 400 }}>
      <h3>API Interceptor (Read-Only)</h3>

      {list.map((item, i) => (
        <div key={i} style={{ marginBottom: 12 }}>
          <b>{item.type}</b> — {item.status}
          <div style={{ fontSize: 11 }}>{item.url}</div>

          <pre
            style={{
              background: "#111",
              color: "#0f0",
              maxHeight: 200,
              overflow: "auto",
              padding: 8
            }}
          >
            {JSON.stringify(item.data, null, 2)}
          </pre>
        </div>
      ))}
    </div>
  );
}

export default App;
