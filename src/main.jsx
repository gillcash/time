import { render } from 'preact';
import { App } from './app';
import { isNative } from './lib/platform';
import './index.css';

render(<App />, document.getElementById('app'));

if (!isNative && 'serviceWorker' in navigator) {
  import('virtual:pwa-register').then(({ registerSW }) => {
    registerSW({ immediate: true });
  });
}
