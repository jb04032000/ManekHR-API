import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CallTodo, CallTodoSchema } from './call-todo.schema';
import { CallTodoController } from './call-todo.controller';
import { CallTodoService } from './call-todo.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: CallTodo.name, schema: CallTodoSchema }]),
  ],
  controllers: [CallTodoController],
  providers: [CallTodoService],
  exports: [MongooseModule, CallTodoService],
})
export class CallTodoModule {}
