import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

interface SettingsData {
  openrouterApiKey?: string;
}

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private readonly settingsPath: string;

  constructor() {
    this.settingsPath = path.join(process.cwd(), 'settings.json');
  }

  getSettings(): { openrouterApiKey: string | null } {
    const data = this.loadFromDisk();
    const key = data.openrouterApiKey || process.env.OPENROUTER_API_KEY || null;
    return {
      openrouterApiKey: key ? this.maskKey(key) : null,
    };
  }

  updateSettings(payload: { openrouterApiKey: string }): { success: boolean } {
    const data = this.loadFromDisk();
    data.openrouterApiKey = payload.openrouterApiKey;
    this.saveToDisk(data);

    // Apply to current process immediately
    process.env.OPENROUTER_API_KEY = payload.openrouterApiKey;
    this.logger.log('OpenRouter API key updated');

    return { success: true };
  }

  private maskKey(key: string): string {
    if (key.length <= 8) return '****';
    return key.slice(0, 5) + '...' + key.slice(-4);
  }

  private loadFromDisk(): SettingsData {
    try {
      if (fs.existsSync(this.settingsPath)) {
        const raw = fs.readFileSync(this.settingsPath, 'utf-8');
        return JSON.parse(raw);
      }
    } catch (err) {
      this.logger.warn('Failed to load settings.json', err);
    }
    return {};
  }

  private saveToDisk(data: SettingsData): void {
    try {
      fs.writeFileSync(this.settingsPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      this.logger.error('Failed to save settings.json', err);
      throw err;
    }
  }

  /**
   * Called at bootstrap to apply persisted settings to process.env.
   */
  static loadSettingsToEnv(): void {
    const settingsPath = path.join(process.cwd(), 'settings.json');
    try {
      if (fs.existsSync(settingsPath)) {
        const raw = fs.readFileSync(settingsPath, 'utf-8');
        const data: SettingsData = JSON.parse(raw);
        if (data.openrouterApiKey && !process.env.OPENROUTER_API_KEY) {
          process.env.OPENROUTER_API_KEY = data.openrouterApiKey;
        }
      }
    } catch {
      // Silently ignore — settings file may not exist yet
    }
  }
}
