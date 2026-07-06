
import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FileText } from 'lucide-react';
import { LogEntry } from '../types';

interface TrainingLogsProps {
  logs: LogEntry[];
  logContainerRef: React.RefObject<HTMLDivElement>;
}

const TrainingLogs: React.FC<TrainingLogsProps> = ({ logs, logContainerRef }) => {
  return (
    <Card className="bg-secondary/50 border-border rounded-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-3 text-foreground">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
            <FileText className="w-5 h-5 text-sky-600" />
          </div>
          Training Logs
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div
          ref={logContainerRef}
          className="bg-card rounded-lg p-4 h-96 overflow-y-auto font-mono text-sm border border-border"
        >
          {logs.length === 0 ? (
            <div className="text-muted-foreground py-8">
              No training logs yet. Start training to see output.
            </div>
          ) : (
            logs.map((log, index) => (
              <div
                key={index}
                className="text-muted-foreground break-words whitespace-pre-wrap"
              >
                <span className="text-muted-foreground mr-2 select-none">
                  {new Date(log.timestamp * 1000).toLocaleTimeString()}
                </span>
                {log.message}
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export default TrainingLogs;
