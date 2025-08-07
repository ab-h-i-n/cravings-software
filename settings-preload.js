const { ipcRenderer, contextBridge } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  // Function to get the initial settings passed from the main process
  getInitialSettings: () => {
    const params = new URLSearchParams(window.location.search);
    return {
      width: params.get('width'),
      height: params.get('height'),
      scaleFactor: params.get('scaleFactor'),
    };
  },

  // Function to send the new settings to be saved
  save: (settings) => ipcRenderer.send('save-print-settings', settings),

  // Function to tell the main process to cancel and close the window
  cancel: () => ipcRenderer.send('cancel-print-settings')
});