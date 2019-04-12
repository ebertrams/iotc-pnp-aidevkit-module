import { service, inject } from 'spryly';
import { spawn } from 'child_process';
import { LoggingService } from './logging';
import { ConfigService } from './config';
import * as _get from 'lodash.get';
import { Transform } from 'stream';
import { platform as osPlatform } from 'os';

const rtspVideoCaptureSource = 'rtsp';
const ffmpegCommand = 'ffmpeg';
const ffmpegCaptureCommandArgsMac = '-f avfoundation -framerate 15 -video_device_index ###VIDEO_SOURCE -i default -loglevel quiet -an -f image2pipe -vf scale=640:360,fps=1/2 -q 1 pipe:1';
const ffmpegCaptureCommandArgsLinux = '-f video4linux2 -i ###VIDEO_SOURCE -framerate 15 -loglevel quiet -an -image2pipe -vf scale=640:360,fps=1/2 -q 1 pipe:1';
// const ffmpegRtspCommandArgs = '-i ###VIDEO_SOURCE -loglevel quiet -an -f image2pipe -vf scale=640:360,fps=1/2 -q 1 pipe:1';
const ffmpegRtspCommandArgs = '-i ###VIDEO_SOURCE -loglevel quiet -an -f image2pipe -vf fps=1/2 -q 1 pipe:1';

@service('videoStreamController')
export class VideoStreamController {
    @inject('logger')
    private logger: LoggingService;

    @inject('config')
    private config: ConfigService;

    private handleVideoFrameCallback: any = null;
    private videoCaptureSource: string = rtspVideoCaptureSource;
    private ffmpegProcess: any = null;
    private ffmpegCommandArgs: string = '';

    public async init(): Promise<void> {
        this.videoCaptureSource = this.config.get('videoCaptureSource') || rtspVideoCaptureSource;

        // tslint:disable-next-line:prefer-conditional-expression
        if (this.videoCaptureSource === rtspVideoCaptureSource) {
            this.ffmpegCommandArgs = ffmpegRtspCommandArgs;
        }
        else {
            this.ffmpegCommandArgs = osPlatform() === 'darwin' ? ffmpegCaptureCommandArgsMac : ffmpegCaptureCommandArgsLinux;
        }
    }

    public setVideoFrameCallback(handleVideoFrame: any) {
        this.handleVideoFrameCallback = handleVideoFrame;
    }

    public async startVideoStreamProcessor(videoStreamUrl: string): Promise<boolean> {
        if (!videoStreamUrl) {
            this.logger.log(['DataStreamController', 'warning'], `Not starting image capture processor because videoStreamUrl is empty`);
        }

        this.logger.log(['VideoStreamController', 'info'], `Starting image capture processes`);

        const videoSource = this.config.get('videoCaptureSource') === 'rtsp' ? videoStreamUrl : this.config.get('videoCaptureSource');

        try {
            this.ffmpegProcess = spawn(ffmpegCommand, this.ffmpegCommandArgs.replace('###VIDEO_SOURCE', videoSource).split(' '), { stdio: ['ignore', 'pipe', 'ignore'] });

            this.ffmpegProcess.on('error', (error) => {
                this.logger.log(['videoController', 'error'], `Error on ffmpegProcess: ${error}`);
                this.ffmpegProcess = null;
            });

            this.ffmpegProcess.on('exit', (code, signal) => {
                this.logger.log(['videoController', 'info'], `Exit on ffmpegProcess, code: ${code}, signal: ${signal}`);
                this.ffmpegProcess = null;
            });

            const frameProcessor = new FrameProcessor({});

            frameProcessor.on('jpeg', (jpegData: any) => {
                (async () => {
                    return this.handleVideoFrameCallback(jpegData);
                })().catch();
            });

            this.ffmpegProcess.stdout.pipe(frameProcessor);

            return true;
        }
        catch (ex) {
            this.logger.log(['videoController', 'error'], ex.message);

            return false;
        }
    }

    public stopVideoStreamProcessor() {
        if (!this.ffmpegProcess) {
            return;
        }

        const process = this.ffmpegProcess;
        this.ffmpegProcess = null;

        process.kill();

        return;
    }
}

const _SOI = Buffer.from([0xff, 0xd8]);
const _EOI = Buffer.from([0xff, 0xd9]);

class FrameProcessor extends Transform {
    private chunks = [];
    private size = 0;
    private internalJpeg: Buffer;
    private internalTimestamp: number;

    constructor(options) {
        super(options);

        this.chunks = [];
        this.size = 0;
        this.internalJpeg = null;
        this.internalTimestamp = Date.now();
    }

    public get jpeg() {
        return this.internalJpeg || null;
    }

    public get timestamp() {
        return this.internalTimestamp;
    }

    // @ts-ignore (encoding)
    public _transform(chunk: Buffer, encoding: string, done: callback) {
        const chunkLength = chunk.length;
        let pos = 0;

        try {
            while (true) {
                if (this.size) {
                    const eoi = chunk.indexOf(_EOI);
                    if (eoi === -1) {
                        this.chunks.push(chunk);
                        this.size += chunkLength;

                        break;
                    } else {
                        pos = eoi + 2;
                        const sliced = chunk.slice(0, pos);
                        this.chunks.push(sliced);
                        this.size += sliced.length;
                        this.internalJpeg = Buffer.concat(this.chunks, this.size);
                        this.internalTimestamp = Date.now();
                        this.chunks = [];
                        this.size = 0;

                        if ((this as any)._readableState.pipesCount > 0) {
                            this.push(this.internalJpeg);
                        }

                        if (this.listenerCount('jpeg') > 0) {
                            this.emit('jpeg', this.internalJpeg);
                        }

                        if (pos === chunkLength) {
                            break;
                        }
                    }
                } else {
                    const soi = chunk.indexOf(_SOI, pos);
                    if (soi === -1) {
                        break;
                    } else {
                        // todo might add option or take sample average / 2 to jump position for small gain
                        pos = soi + 500;
                    }

                    const eoi = chunk.indexOf(_EOI, pos);
                    if (eoi === -1) {
                        const sliced = chunk.slice(soi);
                        this.chunks = [sliced];
                        this.size = sliced.length;

                        break;
                    } else {
                        pos = eoi + 2;
                        this.internalJpeg = chunk.slice(soi, pos);
                        this.internalTimestamp = Date.now();

                        if ((this as any)._readableState.pipesCount > 0) {
                            this.push(this.internalJpeg);
                        }

                        if (this.listenerCount('jpeg') > 0) {
                            this.emit('jpeg', this.internalJpeg);
                        }

                        if (pos === chunkLength) {
                            break;
                        }
                    }
                }
            }
        }
        catch (ex) {
            // tslint:disable no-console variable-name
            console.log(`##JPEG parse exception`);
        }

        return done();
    }
}
