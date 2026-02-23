'use client';

import { useBrowser, Interaction } from '../../providers/browser-provider';
import { useAudioStream } from '../../providers/audio-stream-provider';
import { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import posthog from 'posthog-js';
import { BrowserContainer } from '../components/Browser/BrowserContainer';
import { RecordingGuideModal } from '../components/RecordingGuideModal';
import { MicrophoneSwitchModal } from '../components/MicrophoneSwitchModal';
import { Box, VStack, HStack, Text, Button, Spinner } from '@chakra-ui/react';
import { LuMic } from 'react-icons/lu';
import { toaster } from '../../components/ui/toaster';
import {
  useGenerateWorkflow,
  useGenerateWorkflowFromInteractions,
  useStartRecordingKeepalive,
  useStopRecordingKeepalive,
} from '../../hooks/api';
import { Navbar } from '../components/Navbar';

export default function NewWorkflow() {
  const router = useRouter();

  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const recordingStatusRef = useRef<{
    status: 'idle' | 'processing' | 'completed' | 'failed';
    sessionId?: string;
    localVideoUrl?: string;
  } | null>(null);

  const sessionIdRef = useRef<string | null>(null);
  const isInitializingRef = useRef(false);

  const [duration, setDuration] = useState(0);

  const [hasFailed, setHasFailed] = useState(false);
  const [isInitialMount, setIsInitialMount] = useState(true);
  const [isRequestingPermissions, setIsRequestingPermissions] = useState(false);
  const [showGuide, setShowGuide] = useState(true);
  const [showMicSwitchModal, setShowMicSwitchModal] = useState(false);
  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);

  // Transcript tracking
  const [pendingTranscript, setPendingTranscript] = useState<string>('');
  const [interactionTranscripts, setInteractionTranscripts] = useState<Map<string, string>>(
    new Map(),
  );
  const lastProcessedInteractionRef = useRef<string | null>(null);
  const pendingInteractionRef = useRef<string | null>(null);
  const bufferTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Browser context
  const {
    sessionId,
    pages,
    activePageIndex,
    setActivePageIndex,
    isLoading,
    setIsLoading,
    isAddingTab,
    refreshPages,
    handleTakeControl,
    handleStopSession,
    handleAddTab,
    handleCloseTab,
    handleResetSession,
    interactions,
    navigateCurrentTab,
    goBackCurrentTab,
    goForwardCurrentTab,
    reloadCurrentTab,
    focusUrlBar,
    cdpWsUrlTemplate,
  } = useBrowser();

  const {
    audioStream,
    setAudioStream,
    recordingStatus,
    setRecordingStatus,
    stopAudioRecording,
    startAudioRecording,
    setVideoRecordingStartTime,
    videoRecordingStartTime,
    resetRecordingTimes,
    recordedAudioBlob,
    transcripts,
    clearTranscripts,
    startSpeechToText,
    stopSpeechToText,
  } = useAudioStream();

  const generateWorkflowMutation = useGenerateWorkflow();
  const generateFromInteractionsMutation = useGenerateWorkflowFromInteractions();
  const startRecordingKeepaliveMutation = useStartRecordingKeepalive();
  const stopRecordingKeepaliveMutation = useStopRecordingKeepalive();

  // Clear any leftover recording status on mount
  useEffect(() => {
    if (recordingStatus) {
      if (recordingStatus.localVideoUrl) {
        URL.revokeObjectURL(recordingStatus.localVideoUrl);
      }
      setRecordingStatus(null);
    }
    setIsInitialMount(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-start browser session on mount
  useEffect(() => {
    if (sessionId || recordingStatus || isInitializingRef.current) return;

    if (contentRef.current) {
      isInitializingRef.current = true;
      const { width, height } = contentRef.current.getBoundingClientRect();
      handleTakeControl(Math.floor(width), Math.floor(height));
    }
  }, [sessionId, recordingStatus, handleTakeControl]);

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins > 0) {
      return `(${mins}m ${secs}s)`;
    }
    return `(${secs}s)`;
  };

  useEffect(() => {
    if (!audioStream) {
      setDuration(0);
      return;
    }

    const interval = setInterval(() => {
      setDuration((prev) => prev + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [audioStream]);

  useEffect(() => {
    if (sessionId && audioStream) {
      startAudioRecording();
    }
  }, [sessionId, audioStream, startAudioRecording]);

  // Silence detection: show mic switch modal if no audio after 5 seconds
  useEffect(() => {
    if (!audioStream) {
      // Cleanup when stream stops
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close();
      }
      audioContextRef.current = null;
      analyserRef.current = null;
      return;
    }

    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    const source = audioContext.createMediaStreamSource(audioStream);
    source.connect(analyser);
    audioContextRef.current = audioContext;
    analyserRef.current = analyser;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    silenceTimerRef.current = setTimeout(() => {
      // Check if there's any audio activity
      analyser.getByteFrequencyData(dataArray);
      const maxLevel = Math.max(...dataArray);
      const hasTranscripts = pendingTranscriptRef.current.length > 0;
      console.log(
        '[SILENCE DETECTION] Max audio level after 5s:',
        maxLevel,
        'hasTranscripts:',
        hasTranscripts,
      );

      if (maxLevel < 5 && !hasTranscripts) {
        // No meaningful audio detected and no transcripts received
        setShowMicSwitchModal(true);
      }

      // Cleanup analyser
      source.disconnect();
      if (audioContext.state !== 'closed') {
        audioContext.close();
      }
      audioContextRef.current = null;
      analyserRef.current = null;
    }, 5000);

    return () => {
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
      source.disconnect();
      if (audioContext.state !== 'closed') {
        audioContext.close();
      }
      audioContextRef.current = null;
      analyserRef.current = null;
    };
  }, [audioStream]);

  // Store starting URL interaction - captured once when recording starts
  const [startingUrlInteraction, setStartingUrlInteraction] = useState<Interaction | null>(null);
  const hasSetStartingUrlRef = useRef(false);

  // Reset starting URL state when recording stops
  useEffect(() => {
    if (!videoRecordingStartTime && hasSetStartingUrlRef.current) {
      hasSetStartingUrlRef.current = false;
      setStartingUrlInteraction(null);
    }
  }, [videoRecordingStartTime]);

  // Filter interactions to show clicks, typing, and tab navigations after recording started
  const filteredInteractions = useMemo(() => {
    // Don't show any interactions until recording has actually started
    if (!videoRecordingStartTime) {
      return [];
    }

    const result = interactions.filter((i) => {
      // Only show interactions after recording started
      if (i.timestamp < videoRecordingStartTime) return false;

      // Include clicks, typing, key presses, and tab navigations
      if (i.data?.type === 'click') return true;
      if (i.data?.type === 'keydown') return true;
      if (i.data?.type === 'keypress') return true;
      if (i.type === 'tab_navigation') return true;

      return false;
    });

    // Add starting URL as first item
    if (startingUrlInteraction) {
      return [startingUrlInteraction, ...result];
    }

    return result;
  }, [interactions, videoRecordingStartTime, startingUrlInteraction]);

  // Build up pending transcript from real-time transcripts
  useEffect(() => {
    if (transcripts.length > 0) {
      // Get the latest transcript (excluding interim ones ending with ...)
      const finalTranscripts = transcripts.filter((t) => !t.endsWith('...'));
      const interimTranscript = transcripts.find((t) => t.endsWith('...'));

      // Build the full pending transcript
      const fullText = finalTranscripts.join(' ');
      const displayText = interimTranscript
        ? fullText + (fullText ? ' ' : '') + interimTranscript.slice(0, -3)
        : fullText;

      setPendingTranscript(displayText.trim());
    }
  }, [transcripts]);

  // Keep a ref to the latest pending transcript for the timeout callback
  const pendingTranscriptRef = useRef<string>('');
  useEffect(() => {
    pendingTranscriptRef.current = pendingTranscript;
  }, [pendingTranscript]);

  // Associate pending transcript with the NEW interaction when it occurs
  // Uses a 1s buffer to account for transcription latency
  useEffect(() => {
    if (filteredInteractions.length > 0) {
      const lastInteraction = filteredInteractions[filteredInteractions.length - 1];

      // If this is a new interaction we haven't processed yet
      if (
        lastInteraction.id !== lastProcessedInteractionRef.current &&
        lastInteraction.id !== 'starting-url'
      ) {
        // If there's a pending buffer for a previous interaction, finalize it immediately
        if (bufferTimeoutRef.current && pendingInteractionRef.current) {
          clearTimeout(bufferTimeoutRef.current);
          const prevInteractionId = pendingInteractionRef.current;
          const transcriptToSave = pendingTranscriptRef.current;
          if (transcriptToSave) {
            setInteractionTranscripts((prev) => {
              const newMap = new Map(prev);
              newMap.set(prevInteractionId, transcriptToSave);
              return newMap;
            });
          }
          clearTranscripts();
          setPendingTranscript('');
        }

        // Mark this interaction as pending and start the buffer
        pendingInteractionRef.current = lastInteraction.id;
        lastProcessedInteractionRef.current = lastInteraction.id;

        // Wait 1 second to capture any remaining transcription due to latency
        bufferTimeoutRef.current = setTimeout(() => {
          const interactionId = pendingInteractionRef.current;
          const transcriptToSave = pendingTranscriptRef.current;

          if (interactionId && transcriptToSave) {
            setInteractionTranscripts((prev) => {
              const newMap = new Map(prev);
              newMap.set(interactionId, transcriptToSave);
              return newMap;
            });
          }

          // Clear transcripts for the next interaction
          clearTranscripts();
          setPendingTranscript('');
          pendingInteractionRef.current = null;
          bufferTimeoutRef.current = null;
        }, 1000);
      }
    }
  }, [filteredInteractions, clearTranscripts]);

  // Cleanup buffer timeout on unmount
  useEffect(() => {
    return () => {
      if (bufferTimeoutRef.current) {
        clearTimeout(bufferTimeoutRef.current);
      }
    };
  }, []);

  const handleStartRecording = useCallback(async () => {
    if (!sessionId) {
      toaster.create({
        title: 'Please wait for the browser to load before starting recording.',
        type: 'info',
        duration: 3000,
      });
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log('[RECORD PAGE] Microphone stream obtained');

      // Start backend keepalive for WebSocket connection
      console.log('[RECORD PAGE] Starting backend recording keepalive');
      startRecordingKeepaliveMutation
        .mutateAsync(sessionId)
        .catch((err) => console.error('[RECORD PAGE] Failed to start recording keepalive:', err));

      // Set starting URL immediately when recording starts
      const activePage = pages[activePageIndex] || pages[0];
      if (activePage && !activePage.isSkeleton && !hasSetStartingUrlRef.current) {
        hasSetStartingUrlRef.current = true;
        const recordingStartTime = Date.now();
        setVideoRecordingStartTime(recordingStartTime);
        setStartingUrlInteraction({
          id: 'starting-url',
          type: 'user_event',
          timestamp: recordingStartTime,
          pageId: activePage.id,
          element: {
            tagName: 'NAVIGATION',
            text: activePage.url,
            href: activePage.url,
          },
          data: { type: 'starting_url' },
        });
      }

      setAudioStream(stream);
      clearTranscripts();
      // Pass the stream directly to ensure it's available immediately
      await startSpeechToText(sessionId, stream);
    } catch (error) {
      console.error('[RECORD PAGE] Microphone permission error:', error);
      toaster.create({
        title:
          'Microphone permission denied. Please enable microphone access to record your workflow.',
        type: 'error',
        duration: 4000,
      });
    } finally {
      setIsRequestingPermissions(false);
    }
  }, [
    sessionId,
    setAudioStream,
    clearTranscripts,
    startSpeechToText,
    pages,
    activePageIndex,
    setVideoRecordingStartTime,
    startRecordingKeepaliveMutation,
  ]);

  const handleStopRecording = useCallback(async () => {
    if (sessionId) {
      stopSpeechToText(sessionId);
      // Stop backend keepalive
      console.log('[RECORD PAGE] Stopping backend recording keepalive');
      stopRecordingKeepaliveMutation
        .mutateAsync(sessionId)
        .catch((err) => console.error('[RECORD PAGE] Failed to stop recording keepalive:', err));
    }

    await stopAudioRecording();

    // Track recording stopped event
    posthog.capture('recording_stopped', {
      sessionId,
      recordingDuration: videoRecordingStartTime ? Date.now() - videoRecordingStartTime : 0,
      interactionsCount: filteredInteractions.length,
    });

    // Capture final transcript before any cleanup
    const finalPendingTranscript = pendingTranscriptRef.current;
    const hasPendingInteraction = !!pendingInteractionRef.current;

    // Finalize any pending transcript for an interaction
    if (bufferTimeoutRef.current && pendingInteractionRef.current) {
      clearTimeout(bufferTimeoutRef.current);
      const prevInteractionId = pendingInteractionRef.current;
      const transcriptToSave = finalPendingTranscript;
      if (transcriptToSave) {
        setInteractionTranscripts((prev) => {
          const newMap = new Map(prev);
          newMap.set(prevInteractionId, transcriptToSave);
          return newMap;
        });
      }
    }

    // Prepare interactions with their transcripts for the LLM
    const interactionsWithTranscripts = filteredInteractions.map((interaction) => ({
      ...interaction,
      transcript: interactionTranscripts.get(interaction.id) || '',
    }));

    // If there's a final transcript without an associated interaction, add it as a special entry
    if (finalPendingTranscript && !hasPendingInteraction) {
      const activePage = pages[activePageIndex] || pages[0];
      interactionsWithTranscripts.push({
        id: 'final-transcript',
        type: 'user_event',
        timestamp: Date.now(),
        pageId: activePage?.id || '',
        element: {
          tagName: 'TRANSCRIPT',
          text: 'Final instructions',
        },
        data: { type: 'final_transcript' },
        transcript: finalPendingTranscript,
      });
    }

    console.log('[FRONTEND] Calling LLM with interactions:', interactionsWithTranscripts.length);

    try {
      setIsLoading(true);

      // Store pending flag BEFORE firing mutation so the workflows page
      // has a reliable baseline timestamp to compare against
      sessionStorage.setItem('pendingWorkflowTimestamp', Date.now().toString());

      // Fire mutation without awaiting - backend will process independently
      generateFromInteractionsMutation
        .mutateAsync({
          sessionId: sessionId || undefined,
          interactions: interactionsWithTranscripts,
        })
        .catch((error) => {
          console.error('[FRONTEND] Error generating workflow:', error);
        });

      // Wait 5 seconds with spinner showing
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Navigate to all workflows page
      router.push('/');
    } catch (error) {
      console.error('[FRONTEND] Error generating workflow:', error);
      toaster.create({
        title: error instanceof Error ? error.message : 'Failed to generate workflow',
        type: 'error',
        duration: 4000,
      });
      setIsLoading(false);
    } finally {
      // Cleanup
      setAudioStream((prev) => {
        if (prev) {
          prev.getTracks().forEach((track) => track.stop());
        }
        return null;
      });
      await handleStopSession();
    }
  }, [
    stopAudioRecording,
    stopSpeechToText,
    sessionId,
    filteredInteractions,
    interactionTranscripts,
    generateFromInteractionsMutation,
    router,
    setIsLoading,
    setAudioStream,
    handleStopSession,
    pages,
    activePageIndex,
    stopRecordingKeepaliveMutation,
  ]);

  const handleApproveRecording = useCallback(async () => {
    console.log('[FRONTEND] handleApproveRecording called');
    if (!recordingStatus?.localVideoUrl || !sessionId) {
      console.log('[FRONTEND] Missing video or session, cleaning up');
      if (recordingStatus?.localVideoUrl) {
        URL.revokeObjectURL(recordingStatus.localVideoUrl);
      }
      setRecordingStatus(null);
      await handleStopSession();
      return;
    }

    console.log('[FRONTEND] Setting workflow status to processing');
    setRecordingStatus(
      recordingStatus ? { ...recordingStatus, status: 'processing' } : recordingStatus,
    );

    try {
      const videoBlob = await fetch(recordingStatus.localVideoUrl).then((res) => res.blob());
      const audioBlob = recordedAudioBlob || (await stopAudioRecording());

      if (!audioBlob) {
        throw new Error('Audio recording not available');
      }

      const formData = new FormData();
      formData.append('sessionId', sessionId);
      formData.append('video', videoBlob, 'recording.webm');
      formData.append('audio', audioBlob, 'recording-audio.webm');

      console.log('[FRONTEND] Sending workflow generation request');
      const data = await generateWorkflowMutation.mutateAsync(formData);
      console.log('[FRONTEND] Response received');

      const { workflowId } = data;

      if (workflowId) {
        console.log('[FRONTEND] Navigating to /workflow with ID:', workflowId);
        setTimeout(() => {
          router.push(`/workflow/${workflowId}`);
        }, 500);
      } else {
        throw new Error('No workflow ID returned from server');
      }
    } catch (error) {
      console.error('[FRONTEND] Error approving recording:', error);
      alert(error instanceof Error ? error.message : 'Failed to generate workflow');
    } finally {
      console.log('[FRONTEND] Cleanup: revoking URLs and stopping session');
      if (recordingStatus?.localVideoUrl) {
        URL.revokeObjectURL(recordingStatus.localVideoUrl);
      }
      setRecordingStatus(null);
      await handleStopSession();
    }
  }, [
    recordingStatus,
    sessionId,
    recordedAudioBlob,
    stopAudioRecording,
    generateWorkflowMutation,
    handleStopSession,
    router,
    setRecordingStatus,
  ]);

  const handleReRecordProvider = useCallback(async () => {
    // Track recording discarded event
    posthog.capture('recording_discarded', {
      sessionId,
      recordingDuration: videoRecordingStartTime ? Date.now() - videoRecordingStartTime : 0,
      interactionsCount: filteredInteractions.length,
    });

    if (recordingStatus?.localVideoUrl) {
      URL.revokeObjectURL(recordingStatus.localVideoUrl);
    }

    setRecordingStatus(null);
    resetRecordingTimes();

    setAudioStream((prev) => {
      if (prev) {
        prev.getTracks().forEach((track) => track.stop());
      }
      return null;
    });

    // if (sessionId) {
    //   // Stop backend keepalive when discarding recording
    //   console.log('[RECORD PAGE] Stopping backend recording keepalive (discard)');
    //   stopRecordingKeepaliveMutation
    //     .mutateAsync(sessionId)
    //     .catch((err) => console.error('[RECORD PAGE] Failed to stop recording keepalive:', err));
    //   await handleResetSession();
    // }

    setDuration(0);
    setHasFailed(false);
    setIsLoading(false);

    // Reset transcript tracking
    setPendingTranscript('');
    setInteractionTranscripts(new Map());
    lastProcessedInteractionRef.current = null;
    pendingInteractionRef.current = null;
    if (bufferTimeoutRef.current) {
      clearTimeout(bufferTimeoutRef.current);
      bufferTimeoutRef.current = null;
    }
  }, [
    recordingStatus,
    sessionId,
    handleResetSession,
    setRecordingStatus,
    resetRecordingTimes,
    setAudioStream,
    setIsLoading,
    stopRecordingKeepaliveMutation,
  ]);

  const handleSwitchMicrophone = useCallback(
    async (deviceId: string) => {
      setShowMicSwitchModal(false);

      // Stop current speech-to-text and audio stream
      if (sessionId) {
        stopSpeechToText(sessionId);
      }
      await stopAudioRecording();
      setAudioStream((prev) => {
        if (prev) {
          prev.getTracks().forEach((track) => track.stop());
        }
        return null;
      });

      // Reset transcript tracking
      clearTranscripts();
      setPendingTranscript('');

      try {
        // Get new stream with the selected microphone
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: deviceId } },
        });
        console.log('[RECORD PAGE] Switched to microphone:', deviceId);

        setAudioStream(stream);
        clearTranscripts();
        if (sessionId) {
          await startSpeechToText(sessionId, stream);
        }
      } catch (error) {
        console.error('[RECORD PAGE] Failed to switch microphone:', error);
        toaster.create({
          title: 'Failed to switch microphone. Please try again.',
          type: 'error',
          duration: 4000,
        });
      }
    },
    [
      sessionId,
      stopSpeechToText,
      stopAudioRecording,
      setAudioStream,
      clearTranscripts,
      startSpeechToText,
    ],
  );

  const handleConfirmCurrentMic = useCallback(() => {
    setShowMicSwitchModal(false);
  }, []);

  useEffect(() => {
    return () => {
      setAudioStream((prev) => {
        if (prev) {
          prev.getTracks().forEach((track) => track.stop());
        }
        return null;
      });
    };
  }, [setAudioStream]);

  useEffect(() => {
    recordingStatusRef.current = recordingStatus;
    sessionIdRef.current = sessionId;
  }, [recordingStatus, sessionId]);

  // Cleanup when leaving the page (unmount only)
  useEffect(() => {
    return () => {
      // Clean up recording status
      const currentStatus = recordingStatusRef.current;
      if (currentStatus?.localVideoUrl) {
        URL.revokeObjectURL(currentStatus.localVideoUrl);
      }
      setRecordingStatus(null);

      // Stop browser session if it exists
      const currentSessionId = sessionIdRef.current;
      if (currentSessionId) {
        handleStopSession().catch(console.error);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const transcriptTextRef = useRef<HTMLDivElement>(null);

  const transcriptWords = useMemo(() => {
    if (!pendingTranscript) return [];
    return pendingTranscript.split(/\s+/).filter(Boolean);
  }, [pendingTranscript]);

  // Track how many words were already visible so only new ones animate
  const stableWordCount = useRef(0);
  useEffect(() => {
    // Update after render so the animation plays first
    const timeout = setTimeout(() => {
      stableWordCount.current = transcriptWords.length;
    }, 300);
    return () => clearTimeout(timeout);
  }, [transcriptWords.length]);

  // Auto-scroll transcript text to show the latest words
  useEffect(() => {
    if (transcriptTextRef.current) {
      transcriptTextRef.current.scrollLeft = transcriptTextRef.current.scrollWidth;
    }
  }, [pendingTranscript]);

  const isLoadingRecording =
    isLoading || !!(recordingStatus && recordingStatus.localVideoUrl) || isRequestingPermissions;

  const isRecording = !isRequestingPermissions && sessionId && audioStream;
  const isFirstStep = filteredInteractions.length <= 1;

  return (
    <VStack h="100vh" bg="app.bg" overflow="hidden" align="stretch" gap={0}>
      <Navbar
        centerElement={
          isRecording ? (
            <HStack
              bg="white"
              borderRadius="full"
              border="1px solid"
              borderColor="gray.200"
              px={2}
              pr={4}
              py={1}
              gap={2}
              maxW="500px"
              overflow="hidden"
              transition="width 0.3s ease"
              shadow="sm"
            >
              <Box
                borderRadius="full"
                p={1.5}
                display="flex"
                alignItems="center"
                justifyContent="center"
                flexShrink={0}
                bg="gray.200"
              >
                <LuMic size={16} />
              </Box>
              <Box
                ref={transcriptTextRef}
                fontSize="sm"
                fontWeight="semibold"
                color="gray.800"
                whiteSpace="nowrap"
                overflow="hidden"
                display="flex"
                gap="0.35em"
                alignItems="center"
              >
                {transcriptWords.length === 0 ? (
                  <Text
                    as="span"
                    opacity={0.5}
                    style={{ animation: 'transcript-word-fade-in 0.4s ease forwards' }}
                  >
                    {isFirstStep ? 'Describe your workflow out loud' : 'Describe the next step'}
                  </Text>
                ) : (
                  transcriptWords.map((word, i) => {
                    const isNew = i >= stableWordCount.current;
                    const delayIndex = i - stableWordCount.current;
                    return (
                      <Text
                        as="span"
                        key={`${i}-${word}`}
                        style={{
                          animation: isNew
                            ? `transcript-word-fade-in 0.3s ease ${delayIndex * 80}ms forwards`
                            : undefined,
                          opacity: isNew ? 0 : 1,
                        }}
                      >
                        {word}
                      </Text>
                    );
                  })
                )}
              </Box>
            </HStack>
          ) : undefined
        }
        rightElement={
          <HStack gap={3}>
            <Button
              onClick={audioStream ? handleStopRecording : handleStartRecording}
              disabled={audioStream ? isLoadingRecording : isRequestingPermissions || !sessionId}
              bg="app.primary"
              color="app.onPrimary"
              fontSize="md"
              px={4}
              py={2}
              _hover={{ bg: 'app.primaryAlt' }}
              animation={
                sessionId && !audioStream && !isRequestingPermissions
                  ? 'pulse-glow 2s ease-in-out infinite'
                  : undefined
              }
            >
              {isRequestingPermissions ? (
                <HStack gap={2}>
                  <Spinner size="sm" color="app.onPrimary" />
                  <span>Requesting permissions...</span>
                </HStack>
              ) : !sessionId ? (
                <HStack gap={2}>
                  <Spinner size="sm" color="app.onPrimary" />
                  <span>Loading browser...</span>
                </HStack>
              ) : audioStream ? (
                isLoadingRecording ? (
                  <HStack gap={2}>
                    <Spinner size="sm" color="app.onPrimary" />
                    <span>Creating workflow...</span>
                  </HStack>
                ) : (
                  <HStack gap={2}>Stop Recording {formatDuration(duration)}</HStack>
                )
              ) : (
                <HStack gap={2}>Start Recording</HStack>
              )}
            </Button>

            {audioStream && !isLoadingRecording && (
              <Button onClick={handleReRecordProvider} fontSize="md">
                Discard Recording
              </Button>
            )}
          </HStack>
        }
      />

      {/* <HStack
        borderTop="1px solid"
        borderColor="app.border"
        justify="space-between"
        align="center"
        flexShrink={0}
      >
        {isRecording && (
          <Text
            fontSize="sm"
            color="app.muted"
            fontStyle="italic"
            maxW="50%"
            truncate
            textAlign="right"
          >
            {pendingTranscript ? `"${pendingTranscript}"` : 'Listening...'}
          </Text>
        )}
      </HStack> */}

      <Box
        flex={1}
        p={4}
        pt={0}
        display="flex"
        justifyContent="center"
        alignItems="center"
        minH={0}
        overflow="hidden"
      >
        <Box height="100%" overflow="hidden" width="full" borderRadius="2xl">
          <BrowserContainer
            containerRef={containerRef}
            contentRef={contentRef}
            sessionId={sessionId}
            pages={pages}
            activePageIndex={activePageIndex}
            setActivePageIndex={setActivePageIndex}
            isLoading={isLoading}
            isAddingTab={isAddingTab}
            refreshPages={refreshPages}
            handleAddTab={handleAddTab}
            handleCloseTab={handleCloseTab}
            onNavigate={navigateCurrentTab}
            onGoBack={goBackCurrentTab}
            onGoForward={goForwardCurrentTab}
            onReload={reloadCurrentTab}
            focusUrlBar={focusUrlBar}
            emptyState="skeleton"
            showLoadSkeleton={true}
            minimalOverlay={true}
            cdpWsUrlTemplate={cdpWsUrlTemplate}
          />
        </Box>
      </Box>

      <RecordingGuideModal isOpen={showGuide} onClose={() => setShowGuide(false)} />

      <MicrophoneSwitchModal
        isOpen={showMicSwitchModal}
        onClose={() => setShowMicSwitchModal(false)}
        onSwitchMicrophone={handleSwitchMicrophone}
        onConfirmCurrentMic={handleConfirmCurrentMic}
      />

      {/* VideoPreviewModal temporarily removed
      <VideoPreviewModal
        handleApproveRecording={handleApproveRecording}
        handleReRecordProvider={handleReRecordProvider}
        isInitialMount={isInitialMount}
      />
      */}
    </VStack>
  );
}
