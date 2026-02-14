/**
 * HomePiNAS Mobile - API Client
 * Comunicación con el backend del NAS
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEYS = {
  NAS_URL: 'nas_url',
  SESSION_ID: 'session_id',
  CSRF_TOKEN: 'csrf_token',
};

class NASApi {
  private baseUrl: string = '';
  private sessionId: string = '';
  private csrfToken: string = '';

  async init() {
    this.baseUrl = await AsyncStorage.getItem(STORAGE_KEYS.NAS_URL) || '';
    this.sessionId = await AsyncStorage.getItem(STORAGE_KEYS.SESSION_ID) || '';
    this.csrfToken = await AsyncStorage.getItem(STORAGE_KEYS.CSRF_TOKEN) || '';
  }

  setNasUrl(url: string) {
    this.baseUrl = url.replace(/\/$/, '');
    AsyncStorage.setItem(STORAGE_KEYS.NAS_URL, this.baseUrl);
  }

  setCredentials(sessionId: string, csrfToken: string) {
    this.sessionId = sessionId;
    this.csrfToken = csrfToken;
    AsyncStorage.setItem(STORAGE_KEYS.SESSION_ID, sessionId);
    AsyncStorage.setItem(STORAGE_KEYS.CSRF_TOKEN, csrfToken);
  }

  clearCredentials() {
    this.sessionId = '';
    this.csrfToken = '';
    AsyncStorage.removeItem(STORAGE_KEYS.SESSION_ID);
    AsyncStorage.removeItem(STORAGE_KEYS.CSRF_TOKEN);
  }

  isConnected(): boolean {
    return !!this.baseUrl && !!this.sessionId;
  }

  private async fetch(endpoint: string, options: RequestInit = {}) {
    const url = `${this.baseUrl}/api${endpoint}`;
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options.headers as Record<string, string>,
    };

    if (this.sessionId) {
      headers['X-Session-ID'] = this.sessionId;
    }
    if (this.csrfToken && options.method && options.method !== 'GET') {
      headers['X-CSRF-Token'] = this.csrfToken;
    }

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (response.status === 401) {
      this.clearCredentials();
      throw new Error('Session expired');
    }

    if (response.status === 403) {
      // CSRF error - try to refresh
      throw new Error('CSRF token invalid');
    }

    return response;
  }

  // ========== Auth ==========

  async login(username: string, password: string) {
    const response = await this.fetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });

    const data = await response.json();
    
    if (data.success) {
      this.setCredentials(data.sessionId, data.csrfToken);
    }

    return data;
  }

  async logout() {
    try {
      await this.fetch('/auth/logout', { method: 'POST' });
    } finally {
      this.clearCredentials();
    }
  }

  // ========== System ==========

  async getSystemInfo() {
    const response = await this.fetch('/system/info');
    return response.json();
  }

  async getSystemResources() {
    const response = await this.fetch('/system/resources');
    return response.json();
  }

  // ========== Storage ==========

  async getDisks() {
    const response = await this.fetch('/storage/disks');
    return response.json();
  }

  async getPoolStatus() {
    const response = await this.fetch('/storage/pool/status');
    return response.json();
  }

  // ========== Active Backup ==========

  async getBackupDevices() {
    const response = await this.fetch('/active-backup/devices');
    return response.json();
  }

  async triggerBackup(deviceId: string) {
    const response = await this.fetch(`/active-backup/devices/${deviceId}/backup`, {
      method: 'POST',
    });
    return response.json();
  }

  async getPendingAgents() {
    const response = await this.fetch('/active-backup/agent/pending');
    return response.json();
  }

  async approveAgent(deviceId: string, name: string) {
    const response = await this.fetch(`/active-backup/agent/${deviceId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    return response.json();
  }

  // ========== Files ==========

  async listFiles(path: string = '/') {
    const response = await this.fetch(`/files/list?path=${encodeURIComponent(path)}`);
    return response.json();
  }

  async createFolder(path: string, name: string) {
    const response = await this.fetch('/files/mkdir', {
      method: 'POST',
      body: JSON.stringify({ path, name }),
    });
    return response.json();
  }

  async deleteFile(path: string) {
    const response = await this.fetch('/files/delete', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
    return response.json();
  }

  // ========== Cloud Sync ==========

  async getSyncFolders() {
    const response = await this.fetch('/cloud-sync/folders');
    return response.json();
  }

  async getSyncDevices() {
    const response = await this.fetch('/cloud-sync/devices');
    return response.json();
  }
}

export const nasApi = new NASApi();
export default nasApi;
