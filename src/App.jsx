import { useState } from 'react';
import CameraModule from './components/CameraModule';
import CameraDebugView from './components/CameraDebugView';

function App() {
  // 網址加上 ?debug 就會顯示除錯畫面，例如：
  // https://jamie1002.github.io/smart-inspection-webapp/?debug
  const [isDebugMode] = useState(() => {
    return new URLSearchParams(window.location.search).has('debug');
  });

  return (
    <div>
      {isDebugMode ? <CameraDebugView /> : <CameraModule />}
    </div>
  );
}

export default App;