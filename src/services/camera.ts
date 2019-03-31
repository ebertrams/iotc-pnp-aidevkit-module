import { service, inject } from '@sseiber/sprightly';
import { Server } from 'hapi';
import * as request from 'request';
import { EventEmitter } from 'events';
import * as _get from 'lodash.get';
import { promisify } from 'util';
import { exec } from 'child_process';
import { platform as osPlatform } from 'os';
import { ConfigService } from './config';
import { LoggingService } from './logging';
import { FileHandlerService } from './fileHandler';
import { ICameraResult } from './peabodyTypes';
import { DataStreamController } from './dataStreamProcessor';

const defaultresolutionSelectVal: number = 1;
const defaultencodeModeSelectVal: number = 1;
const defaultbitRateSelectVal: number = 3;
const defaultfpsSelectVal: number = 1;
const defaultMaxLoginAttempts: number = 3;
const defaultDeviceName: string = 'Peabody';
const defaultRtspVideoPort: string = '8900';
const defaultIpcPort: string = '1080';

@service('camera')
export class CameraService extends EventEmitter {
    @inject('$server')
    private server: Server;

    @inject('config')
    private config: ConfigService;

    @inject('logger')
    private logger: LoggingService;

    @inject('fileHandler')
    private fileHandler: FileHandlerService;

    @inject('dataStreamController')
    private dataStreamController: DataStreamController;

    private deviceName: string = defaultDeviceName;
    private maxLoginAttempts: number = defaultMaxLoginAttempts;
    private rtspVideoPort: string = defaultRtspVideoPort;
    private ipAddresses: any = {
        cameraIpAddress: '127.0.0.1',
        hostIpAddress: '127.0.0.1'
    };
    private sessionToken: string = '';
    private ipcPort: string = defaultIpcPort;
    private vamUrl: string = '';
    private resolutions: string[] = [];
    private encoders: string[] = [];
    private bitRates: string[] = [];
    private frameRates: number[] = [];
    private videoSettings = {
        resolutionSelectVal: defaultresolutionSelectVal,
        encodeModeSelectVal: defaultencodeModeSelectVal,
        bitRateSelectVal: defaultbitRateSelectVal,
        fpsSelectVal: defaultfpsSelectVal,
        displayOut: 0
    };
    private modelFiles: string[] = [];

    public get currentResolutionSelectVal() {
        return this.videoSettings.resolutionSelectVal;
    }

    public get currentEncodeModeSelectVal() {
        return this.videoSettings.encodeModeSelectVal;
    }

    public get currentBitRateSelectVal() {
        return this.videoSettings.bitRateSelectVal;
    }

    public get currentFpsSelectVal() {
        return this.videoSettings.fpsSelectVal;
    }

    public get currentDisplayOutVal() {
        return this.videoSettings.displayOut;
    }

    public async init(): Promise<void> {
        this.logger.log(['CameraService', 'info'], 'initialize');

        this.maxLoginAttempts = this.config.get('maxLoginAttemps') || defaultMaxLoginAttempts;
        this.deviceName = this.config.get('deviceName') || defaultDeviceName;
        this.rtspVideoPort = this.config.get('rtspVideoPort') || defaultRtspVideoPort;
        this.ipcPort = this.config.get('ipcPort') || defaultIpcPort;

        // ###
        // ### Need a way to reset services when a new image is deployed
        // ###

        // await this.resetCameraServices();
        await this.login();
    }

    public async login(): Promise<ICameraResult> {
        let status = false;

        try {
            if (this.sessionToken) {
                this.logger.log(['CameraService', 'info'], `Logging out of existing session (${this.sessionToken})`);

                await this.logout();
            }

            this.ipAddresses = await this.getWlanIp();

            this.logger.log(['CameraService', 'info'], `Logging into new session`);

            status = await this.ipcLogin();

            if (status === true) {
                status = await this.initializeCamera();
            }

            if (status === true) {
                const response = await this.getConfiguration();
                status = response.status;
            }
        }
        catch (ex) {
            this.logger.log(['CameraService', 'error'], ex.message);
        }
        finally {
            if (status === false && this.sessionToken) {
                this.logger.log(['CameraService', 'error'], `Error during initialization, logging out`);

                await this.logout();
            }
        }

        return {
            status,
            title: 'Login',
            message: status ? 'Succeeded' : `An error occurred while trying to log into the ${this.deviceName} device. Try rebooting the device and login again.`
        };
    }

    public async logout(): Promise<ICameraResult> {
        let status = false;

        try {
            this.dataStreamController.stopDataStreamProcessor();

            for (let iLogoutAttempts = 0; status === false && iLogoutAttempts < 3; ++iLogoutAttempts) {
                try {
                    status = await this.ipcPostRequest('/logout', {});
                    break;
                }
                catch (ex) {
                    if (ex.code !== 'ESOCKETTIMEDOUT') {
                        throw new Error(ex);
                    }
                }
            }

            this.sessionToken = '';

            status = true;
        }
        catch (ex) {
            this.logger.log(['CameraService', 'error'], ex.message);

            status = false;
        }

        return {
            status,
            title: 'Logoff',
            message: status ? 'Succeeded' : `The attempt to log out of the ${this.deviceName} device didn't complete successfully. Try rebooting the device and login again.`
        };
    }

    public async getConfiguration(): Promise<ICameraResult> {
        if (!this.sessionToken) {
            return {
                status: true,
                title: 'Camera',
                message: `A valid session is required to retrieve camera configuration settings. Try logging in first.`,
                body: {}
            };
        }
        else {
            try {
                const ensureResult = await this.fileHandler.ensureModelFilesExist(this.fileHandler.currentModelFolderPath);
                this.modelFiles = ensureResult.modelFiles;

                return {
                    status: true,
                    title: 'Camera',
                    message: 'Succeeded',
                    body: {
                        sessionToken: this.sessionToken,
                        ipAddresses: this.ipAddresses,
                        rtspUrl: `rtsp://${this.ipAddresses.cameraIpAddress}:${this.rtspVideoPort}/live`,
                        vamUrl: this.vamUrl,
                        resolution: this.resolutions[this.videoSettings.resolutionSelectVal],
                        resolutions: this.resolutions,
                        encoder: this.encoders[this.videoSettings.encodeModeSelectVal],
                        encoders: this.encoders,
                        bitRate: this.bitRates[this.videoSettings.bitRateSelectVal],
                        bitRates: this.bitRates,
                        frameRate: this.frameRates[this.videoSettings.fpsSelectVal],
                        frameRates: this.frameRates,
                        modelFiles: this.modelFiles
                    }
                };
            }
            catch (ex) {
                this.logger.log(['CameraService', 'error'], ex.message);

                return {
                    status: false,
                    title: 'Camera',
                    message: `An error occurred while trying to get configuration settings from the ${this.deviceName} device.`
                };
            }
        }
    }

    public async changeModel(file: any): Promise<ICameraResult> {
        let status = false;

        try {
            status = await this.fileHandler.uploadAndVerifyModelFiles(file);

            if (status) {
                await this.logout();
                status = true;
            }

            if (status) {
                status = await this.fileHandler.changeModelFiles(file);
            }

            if (status) {
                const result = await this.login();
                status = result.status;
            }

            if (status) {
                this.server.publish('/api/v1/subscription/model', this.modelFiles);
            }
        }
        catch (ex) {
            this.logger.log(['CameraService', 'error'], ex.message);

            status = false;
        }

        return {
            status,
            title: 'Camera',
            message: status
                ? 'Succeeded'
                : 'An error occurred while updating your vision model files'
        };
    }

    public async togglePreview(switchStatus: boolean): Promise<ICameraResult> {
        let status;

        try {
            status = await this.ipcPostRequest('/preview', { switchStatus });
        }
        catch (ex) {
            this.logger.log(['CameraService', 'error'], ex.message);

            status = false;
        }

        return {
            status,
            title: 'Camera',
            message: status ? 'Succeeded' : `The attempt to switch ${status ? 'on' : 'off'} the video output didn't complete successfully.`
        };
    }

    public async toggleVam(switchStatus: boolean): Promise<boolean> {
        try {
            return this.ipcPostRequest('/vam', { switchStatus, vamconfig: 'MD' });
        }
        catch (ex) {
            this.logger.log(['CameraService', 'error'], ex.message);

            return false;
        }
    }

    public async toggleOverlay(status): Promise<boolean> {
        try {
            return this.ipcPostRequest('/overlay', { switchStatus: status });
        }
        catch (ex) {
            this.logger.log(['CameraService', 'error'], ex.message);

            return false;
        }
    }

    public async configureDisplayOut(videoSettings): Promise<boolean> {
        const payload = {
            resolutionSelectVal: (videoSettings.resolutionSelectVal < this.resolutions.length) ? videoSettings.resolutionSelectVal : this.videoSettings.resolutionSelectVal,
            encodeModeSelectVal: (videoSettings.encodeModeSelectVal < this.encoders.length) ? videoSettings.encodeModeSelectVal : this.videoSettings.encodeModeSelectVal,
            bitRateSelectVal: (videoSettings.bitRateSelectVal < this.bitRates.length) ? videoSettings.bitRateSelectVal : this.videoSettings.bitRateSelectVal,
            fpsSelectVal: (videoSettings.fpsSelectVal < this.frameRates.length) ? videoSettings.fpsSelectVal : this.videoSettings.fpsSelectVal,
            displayOut: videoSettings.displayOut
        };

        try {
            const result = await this.ipcPostRequest('/video', payload);

            this.videoSettings = {
                ...payload
            };

            return result;
        }
        catch (ex) {
            this.logger.log(['CameraService', 'error'], ex.message);

            return false;
        }
    }

    public configureOverlay(type: string, text?: string): Promise<boolean> {
        if (type === 'inference') {
            return this.configureInferenceOverlay();
        }
        else if (type === 'text') {
            return this.configureTextOverlay(text);
        }

        this.logger.log(['CameraService', 'error'], 'Invalid overlay type use (inference/text)');
        return Promise.resolve(false);
    }

    private async initializeCamera(): Promise<boolean> {
        this.logger.log(['CameraService', 'info'], `Starting camera initial configuration`);

        try {
            let result = false;

            const videoSettings = {
                ...this.videoSettings,
                displayOut: 1
            };

            this.logger.log(['CameraService', 'info'], `Setting video configuration: ${JSON.stringify(videoSettings)}`);

            result = await this.configureDisplayOut(videoSettings);

            if (result === true) {
                this.logger.log(['CameraService', 'info'], `Retrieving camera settings`);

                const response = JSON.parse(await this.ipcGetRequest('/video'));
                result = response.status;

                if (result === true) {
                    this.videoSettings.resolutionSelectVal = response.resolutionSelectVal;
                    this.resolutions = [...response.resolution];
                    this.videoSettings.encodeModeSelectVal = response.encodeModeSelectVal;
                    this.encoders = [...response.encodeMode];
                    this.videoSettings.bitRateSelectVal = response.bitRateSelectVal;
                    this.bitRates = [...response.bitRate];
                    this.videoSettings.fpsSelectVal = response.fpsSelectVal;
                    this.frameRates = [...response.fps];
                    this.videoSettings.displayOut = response.displayOut;
                }
            }

            if (result === true) {
                this.logger.log(['CameraService', 'info'], `Turning on preview`);

                result = await await this.ipcPostRequest('/preview', { switchStatus: true });
            }

            if (result === true) {
                const ensureResult = await this.fileHandler.ensureModelFilesExist(this.fileHandler.currentModelFolderPath);
                if (ensureResult.dlcExists) {
                    this.logger.log(['CameraService', 'info'], `Turning on VAM`);

                    result = await this.ipcPostRequest('/vam', { switchStatus: true, vamconfig: 'MD' });

                    if (result === true) {
                        this.logger.log(['CameraService', 'info'], `Retrieving RTSP VAM url`);

                        result = await this.getRtspVamUrl();
                    }

                    if (result === true) {
                        this.logger.log(['CameraService', 'info'], `Starting data stream processor`);

                        result = await this.dataStreamController.startDataStreamProcessor(this.vamUrl);
                    }

                    if (result === true) {
                        this.logger.log(['CameraService', 'info'], `Configuring inference overlay`);

                        result = await this.configureOverlay('inference');
                    }

                    if (result === true) {
                        this.logger.log(['CameraService', 'info'], `Turning on inference overlay`);

                        result = await this.ipcPostRequest('/overlay', { switchStatus: true });
                    }
                }
            }

            return result;
        }
        catch (ex) {
            this.logger.log(['CameraService', 'error'], `Failed during initSession: ${ex.message}`);

            return false;
        }
    }

    private async configureInferenceOverlay(): Promise<boolean> {
        const payload = {
            ov_type_SelectVal: 5,
            ov_position_SelectVal: 0,
            ov_color: '869007615',
            ov_usertext: 'Text',
            ov_start_x: 0,
            ov_start_y: 0,
            ov_width: 0,
            ov_height: 0
        };

        try {
            return this.ipcPostRequest('/overlayconfig', payload);
        }
        catch (ex) {
            this.logger.log(['CameraService', 'error'], ex.message);

            return false;
        }
    }

    private async configureTextOverlay(text: string): Promise<boolean> {
        const payload = {
            ov_type_SelectVal: 0,
            ov_position_SelectVal: 0,
            ov_color: '869007615',
            ov_usertext: text,
            ov_start_x: 0,
            ov_start_y: 0,
            ov_width: 0,
            ov_height: 0
        };

        try {
            return this.ipcPostRequest('overlayconfig', payload);
        }
        catch (ex) {
            this.logger.log(['CameraService', 'error'], ex.message);

            return false;
        }
    }

    private async getRtspVamUrl(): Promise<boolean> {
        try {
            const response = await this.ipcGetRequest('/vam');
            const result = JSON.parse(response);

            this.vamUrl = result.url || '';

            return result.status;
        }
        catch (ex) {
            this.logger.log(['CameraService', 'error'], ex.message);

            return false;
        }
    }

    // private async getRtspVideoUrl(): Promise<boolean> {
    //     try {
    //         const response = await this.ipcGetRequest('/preview');
    //         const result = JSON.parse(response);

    //         this.rtspUrl = result.url || '';

    //         return result.status;
    //     }
    //     catch (ex) {
    //         this.logger.log(['CameraService', 'error'], ex.message);

    //         return false;
    //     }
    // }

    private async ipcLogin(): Promise<boolean> {
        try {
            const options = {
                method: 'POST',
                url: `http://${this.ipAddresses.cameraIpAddress}:${this.ipcPort}/login`,
                json: true,
                body: {
                    username: this.config.get('user'),
                    userpwd: this.config.get('password')
                }
            };

            this.logger.log(['ipcProvider', 'info'], `LOGIN API: ${options.url}`);

            let result = {
                body: {
                    status: false
                }
            };

            for (let iLoginAttempts = 0; !_get(result, 'body.status') && iLoginAttempts < this.maxLoginAttempts; ++iLoginAttempts) {
                try {
                    if (iLoginAttempts > 0) {
                        this.logger.log(['ipcProvider', 'warn'], `LOGIN ATTEMPT ${iLoginAttempts + 1} of ${this.maxLoginAttempts}: ${options.url}`);
                    }

                    result = await this.makeRequest(options);
                }
                catch (ex) {
                    if (ex.code !== 'ETIMEDOUT') {
                        throw new Error(ex);
                    }
                }
            }

            const status = _get(result, 'body.status');
            this.logger.log(['ipcProvider', 'info'], `RESPONSE BODY: ${status}`);

            if (status === true) {
                this.logger.log(['ipcProvider', 'info'], `RESPONSE COOKIE: ${_get(result, 'response.headers[set-cookie][0]')}`);

                this.sessionToken = _get(result, 'response.headers[set-cookie][0]');
            }
            else {
                this.logger.log(['ipcProvider', 'info'], `Error durring logon`);
            }

            return status;
        }
        catch (ex) {
            this.logger.log(['ipcProvider', 'error'], ex.message);

            throw new Error(ex.message);
        }
    }

    private async ipcGetRequest(path: string, params?: string): Promise<any> {
        try {
            const result = await this.ipcRequest('GET', path, {}, params);

            return result;
        }
        catch (ex) {
            this.logger.log(['ipcProvider', 'error'], ex.message);

            return {
                status: false
            };
        }
    }

    private async ipcPostRequest(path: string, payload: any, params?: string): Promise<boolean> {
        try {
            const result = await this.ipcRequest('POST', path, payload, params);

            return result;
        }
        catch (ex) {
            this.logger.log(['ipcProvider', 'error'], ex.message);

            return false;
        }
    }

    private async ipcRequest(method: string, path: string, payload: any, params?: string): Promise<any> {
        if (!this.sessionToken) {
            throw new Error('No valid login session available');
        }

        try {
            const url = params ? `${path}?${params}` : path;
            const options = {
                method,
                url: `http://${this.ipAddresses.cameraIpAddress}:${this.ipcPort}${url}`,
                headers: {
                    Cookie: this.sessionToken
                }
            };

            if (method === 'POST' && payload) {
                Object.assign(options, {
                    json: true,
                    body: payload
                });
            }

            // this.logger.log(['ipcProvider', 'info'], `${method} API: ${options.url}`);

            const result = await this.makeRequest(options);

            await this.sleep(250);

            this.logger.log(['ipcProvider', 'info'], `RESPONSE: ${JSON.stringify(_get(result, 'body'))}`);

            const bodyResult = (method === 'POST') ? _get(result, 'body.status') : _get(result, 'body');

            return bodyResult;
        }
        catch (ex) {
            this.logger.log(['ipcProvider', 'error'], ex.message);

            throw new Error(ex.message);
        }
    }

    private async makeRequest(options): Promise<any> {
        return new Promise((resolve, reject) => {
            request({
                timeout: 10000,
                ...options
            }, (requestError, response, body) => {
                if (requestError) {
                    this.logger.log(['ipcProvider', 'error'], `makeRequest: ${requestError.message}`);
                    return reject(requestError);
                }

                if (response.statusCode < 200 || response.statusCode > 299) {
                    this.logger.log(['ipcProvider', 'error'], `Response status code = ${response.statusCode}`);

                    const errorMessage = body.message || body || 'An error occurred';
                    return reject(new Error(`Error statusCode: ${response.statusCode}, ${errorMessage}`));
                }

                return resolve({
                    response,
                    body
                });
            });
        });
    }

    private async sleep(milliseconds: number): Promise<void> {
        return new Promise((resolve) => {
            setTimeout(() => {
                return resolve();
            }, milliseconds);
        });
    }

    private async getWlanIp() {
        let cameraIpAddress = this.config.get('cameraIpAddress');

        if (!cameraIpAddress) {
            // const ifConfigFilter = `ip addr show wlan0 | grep 'inet ' | awk '{print $2}' | cut -f1 -d'/'`;
            let ifConfigFilter;

            switch (osPlatform()) {
                case 'darwin':
                    ifConfigFilter = `ifconfig | grep "inet " | grep -v 127.0.0.1 | cut -d\  -f2`;
                    break;

                case 'win32':
                    ifConfigFilter = `echo .`;
                    break;

                case 'linux':
                default:
                    ifConfigFilter = `ifconfig wlan0 | grep 'inet' | cut -d: -f2 | awk '{print $2}'`;
                    break;
            }

            try {
                const { stdout } = await promisify(exec)(ifConfigFilter, { encoding: 'utf8' });

                this.logger.log(['ipcProvider', 'info'], `get ip stdout: ${stdout}`);

                cameraIpAddress = (stdout || '127.0.0.1').trim();
            }
            catch (ex) {
                this.logger.log(['ipcProvider', 'error'], `get ip stderr: ${ex.message}`);
            }
        }

        return {
            cameraIpAddress,
            hostIpAddress: this.config.get('hostIpAddress') || cameraIpAddress
        };
    }
}
