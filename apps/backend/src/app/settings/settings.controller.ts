import { Body, Controller, Get, Put } from '@nestjs/common';
import { SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  getSettings() {
    return this.settingsService.getSettings();
  }

  @Put()
  updateSettings(@Body() body: { openrouterApiKey: string }) {
    return this.settingsService.updateSettings(body);
  }
}
